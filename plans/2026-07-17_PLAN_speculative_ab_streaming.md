# PLAN: Speculative A/B Streaming — Commit Memory Immediately, Interrupt by SSE Splice

> Refines the live with-memory vs full-history routing
> (`plans/2026-06-09_PLAN_local_proxy_app.md`; `src/proxy.ts`
> `forwardComparedSse` / `BufferedUpstreamLeg`, `src/ab-routing.ts`).
> Client-only change in this repo; no server work required.
>
> **STATUS 2026-07-17: PROPOSED.** Companion plan (written same day):
> `plans/2026-07-17_PLAN_transparency_notices.md` — notice surface changes that
> must stay compatible with this design (see "Interactions" below).
>
> **STATUS 2026-07-18: IMPLEMENTED (P1–P4 unit/integration).** `src/splice.ts`
> (event-aligned forwarder + `SseSpliceWriter`), speculative orchestration in
> `src/proxy.ts` (`forwardSpeculativeSse`), bookkeeping/notices/reqlog
> fields, and the P4 fake-upstream
> scenarios are in. One deviation, made for robustness: an A leg that is
> healthy but produces NO stream progress within `prefixTimeoutMs` while B is
> already producing fails over to whole-B (`memory-no-progress-before-commit`)
> — commit is defined as A's first forwarded event, not its response headers.
> **S1 PASSED (2026-07-19):** `scripts/spike-s1.mjs` runs the franken-message
> replay headlessly (no interactive CC session needed — real `claude -p`
> turns supply signed thinking, B text/tool_use, and CC's verbatim
> headers/body). Both shapes accepted (200) direct to Anthropic AND via the
> proxy; an altered-history variant also passed, so the thinking signature is
> not bound to surrounding context. Speculative delivery remains available via
> `--ab-speculative`; buffered grade-before-delivery was restored as the
> default on 2026-07-20, with `--ab-buffered` available as an explicit override.
> **Outstanding:** the P4 manual staging pass (yoyo ping TTFT check;
> forced-B splice UX eyeball; confirm CC's own transcript re-serialization of
> a LIVE spliced stream — the one S1 gap the API-check form can't cover).

## Motivation (measured, not hypothetical)

The buffered A/B design gates the client's first byte on
`max(legA, legB) prefix-ready` **plus** a grader round trip. From
`~/.claude-code-infinite/logs/requests.jsonl` for the 2026-07-16 staging
session (7 comparisons):

- `prefixWaitMs`: median **14,974**, max **30,002** (= `prefixTimeoutMs`
  ceiling, hit by extended thinking producing no gradable text).
- Short answers are the worst case: prefix-ready only fires at `message_stop`
  (`proxy.ts` `observeEvent`), so a 7-token reply waits for **both complete
  responses** — the memory leg's uncached ~148k-token prefill and the full
  leg's 330–511k cache read/write.
- The grader succeeded **0/7** times (4× HTTP 429 `rate_limit_error` — fired at
  the exact moment both legs saturated the org input-token limit — 3× no
  response). Every turn paid double generation for zero routing signal, then
  defaulted to memory anyway.

The verdict rubric already treats memory (A) as the preferred default and
reserves B for "materially better" (`ab-routing.ts`
`buildFusionGraderSystemPrompt`, `winnerForVerdict`: A and tie both keep
memory). So delivery should assume A and treat a B verdict as a rare,
recoverable interruption — not hold every turn hostage to the comparison.

## Design summary

1. **Speculative commit.** In compare mode, leg A (memory) streams to the
   client from its first upstream byte. Client TTFT becomes A's TTFB. Leg B
   (full history) streams into its buffer exactly as today.
2. **Shadow grading.** The grader runs off the delivery path, when both
   prefixes are ready (unchanged trigger). Because nothing waits on it, a 429
   now gets one retry with backoff instead of a user-visible failure.
3. **Interrupt by splice.** If the verdict is B and the interrupt window is
   still open, the proxy aborts A upstream, closes A's open content block in
   the client stream, and splices B's buffered content into the same SSE
   message envelope as new content blocks. The user sees the assistant
   visibly change course mid-message.
4. **No minimum wait for B** (decided 2026-07-17): A's `message_stop` is never
   held back. Short responses therefore complete before B can be graded and A
   wins by default — accepted. The shadow grade still runs afterward for
   telemetry/priors.
5. **Live failover.** If A fails before its first byte, commit B whole
   (today's fallback, minus the wait). If A fails mid-stream, splice B in as
   recovery — a turn that today ends `followup-ab-failed` becomes a save.

Non-compare paths (below-gate, degraded, tool turns, legacy embedder mode) are
untouched.

## Interrupt state machine

Window: opens when A's bytes start flowing to the client; closes at the first
of the events below. A "splice" always means: abort A upstream, close A's open
client-visible block, emit the bridge block, then replay B (see next section).

| A-stream state when B verdict arrives  | Action |
| --- | --- |
| Mid text block (`text_delta`s flowing) | Splice now: `content_block_stop` for the open text block at its current index, then bridge + B. |
| Mid **thinking** block                 | **Defer** until that block's `content_block_stop`. A partial thinking block lacks its `signature_delta`; truncating it would poison replay. Then splice. |
| A has emitted a `tool_use` `content_block_start` | **Point of no return — no splice.** Claude Code executes every tool_use in the message once it completes; mixing A's tool call with B's prose produces an incoherent turn. Commit to A; verdict is logged as late. |
| A `message_stop` already delivered     | Late verdict: log only (`verdictLate: true`). Delivered turn stands. |
| A failed, no bytes sent                | Commit B whole via existing `commitTo` (headers included) — full failover, not a splice. |
| A failed after bytes sent              | Recovery splice: same mechanics, bridge copy notes the recovery; `turnType: followup-ab-recovered`. B needs no verdict for this — any healthy B qualifies (`hasHealthyFallbackEvidence`). |

The deferred-mid-thinking case re-checks the table when the block closes (A
may have moved to tool_use meanwhile → no splice).

## Splice mechanics (SSE event surgery)

To splice we must know exactly what has been emitted, so in compare mode A's
delivery goes through an **event-aligned forwarder** rather than raw chunk
piping: parse A's SSE with the same machinery `SseNoticeRewriter` already uses
(it did prelude fabrication + index renumbering in the pre-hook notice era),
forward each event's bytes verbatim on event boundaries, and track: current
block index, open block type, whether any tool_use started, whether
`message_stop` passed. Per-event flushing adds no meaningful latency.

Splicing B into A's envelope:

- **Skip** B's `message_start` (A's is already on the wire) and B's `ping`s.
- **Renumber** B's content block indices by `offset = lastAIndex + 1 + 1`
  (one slot reserved for the bridge block).
- **Drop B's thinking blocks.** Text and tool_use blocks splice verbatim.
  Signed thinking from another message inside A's envelope is the riskiest
  replay surface; B's thinking has no client-facing value. (Replay risk of the
  resulting message is Spike S1.)
- **Bridge block**: a fabricated text block at `lastAIndex + 1`:
  `"\n\n—\nCorrecting course — the full conversation history changes this:\n\n"`
  (recovery variant: `"\n\n—\nThe first attempt was cut off; continuing from
  the full conversation history:\n\n"`). Configurable via
  `abRouting.bridgeText`. This text is a permanent, model-visible part of the
  assistant message — deliberately honest, short, and neutral; it is NOT a
  notice and is never scrubbed.
- **Close** with B's `message_delta` (stop_reason, usage) and `message_stop`.
  Client-visible usage therefore reflects B's accounting only — cosmetic,
  accepted; the reqlog keeps both legs' true usage.
- Backpressure: same pause/drain handling as `commitTo`.

New unit-testable module: `src/splice.ts` (`SseSpliceWriter`) so the event
transforms are testable without HTTP.

## Leg B lifecycle and shadow grading

- B runs until its gradable prefix (or `prefixTimeoutMs`), even if A has
  already fully delivered — the verdict is the research signal that updates
  effective-context priors, and today's design already let the loser run
  (`loserAborted: false` on all 7 logged comparisons). After grading (or
  timeout), B is aborted.
- Grader: unchanged prompt/schema; now retried **once** on 429/network error
  with 2–5s jittered backoff (affordable off-path). `graderTimeoutMs` still
  bounds each attempt. A verdict that arrives after the window closed is
  recorded, never applied.
- `decisionAbort` semantics change: it cancels *grading*, not delivery. A's
  client abort (`res.close`) still aborts everything.

## Bookkeeping

- **turnTypes**: `followup-ab-memory` (A delivered clean — now the common
  case), `followup-ab-full` (B committed whole after A failed pre-byte),
  **new** `followup-ab-spliced`, **new** `followup-ab-recovered`,
  `followup-ab-failed` (both legs dead).
- **reqlog** `comparison` additions: `speculative: true`,
  `clientTtfbMs` (first byte to client — the headline metric this plan
  exists to fix), `interrupt: "none" | "spliced" | "deferred-then-spliced" |
  "blocked-tool-use" | "late-verdict" | "recovered"`, `spliceAtChars`,
  `verdictLate: boolean`, `graderRetries`. `winner` keeps meaning "what the
  verdict chose"; **new** `delivered` field records what the client actually
  got, since they now diverge (M1c measurement-contract note: prior updates
  key off `verdict`, not `delivered`).
- **Route bookkeeping** (`installMainMemoryRoute` / `onDecision` /
  `onDeliveryComplete`): keyed off *delivered* content. A delivered (even with
  a late B verdict) → install memory route; spliced or recovered or B
  delivered → clear `mainMemoryRoute` (matches current winner==full
  behavior). Epoch guards unchanged.
- **Notices** (`queueCompressionNotice` and friends): A-clean keeps the
  existing success notice on `deliveryOk`. Splice queues a new suffix notice:
  `"MemTree · full history overrode memory this turn"`. Recovery reuses the
  degraded notice path. Coordinate copy with the transparency-notices plan.

## Implementation phases

**S1 — Spike (do first, mirrors the 2026-07-05 thinking round-trip spike):**
record a real CC turn, hand-craft the two franken-message shapes —
(a) A-thinking(signed) + A-text-partial + bridge + B-text,
(b) same but B content ends in tool_use — replay both through the proxy with
CC's own headers, assert Anthropic 200 on the *next* turn. If (b) is rejected,
tool_use blocks from B become a no-splice case (commit-to-A window rule
extends to "B content containing tool_use"), and the plan proceeds otherwise
unchanged.

**P1 — `src/splice.ts`:** event-aligned forwarder + `SseSpliceWriter`
(renumbering, bridge, thinking-drop, message close), pure functions over
parsed SSE events. Unit tests with synthetic streams: mid-text splice,
deferred-thinking splice, tool_use lockout, index renumbering, backpressure.

**P2 — orchestration:** rewrite `forwardComparedSse` around the state machine:
immediate A commit through the forwarder, shadow-grade task with retry,
interrupt-window tracking, failover paths. `BufferedUpstreamLeg` keeps its
buffering role for B and gains nothing A-specific (A's forwarder wraps its
observer).

**P3 — bookkeeping:** reqlog fields, turnTypes, notices, route updates,
`abRouting.speculative` option (`--ab-speculative` enables the mode explicitly;
buffered delivery remains the default even though S1 has now passed).

**P4 — tests + verification:** extend `test/ab-routing.test.mjs` fake-upstream
harness: slow-B/fast-A (A wins, late verdict logged), B-verdict mid-A-text
(splice, transcript shows bridge), B-verdict during A thinking (deferred),
A-tool_use-then-verdict (no splice), A dies mid-stream (recovery), grader 429
twice (no user impact), client disconnect during splice. Manual staging pass:
re-run the yoyo ping test and confirm client TTFT ≈ compress + A TTFB; then a
real long turn with a forced B verdict (`forceComparison` + injected grader)
to eyeball the mid-message correction UX in CC.

## Interactions

- **Transparency notices plan** (same day): its Anthropic-request notices
  must not assume delivery waits on grading; this plan's `clientTtfbMs` and
  splice notices are the touchpoints. Neither plan blocks the other.
- Compress latency (median 4.5s blocking, 13 MB uploads) and the memory leg's
  missing `cache_control` breakpoints are **out of scope** here — they are the
  remaining TTFT floor after this plan and deserve their own plans (gzip/image
  strip/incremental indexing; breakpoint injection).

## Residual risks

- **Franken-message replay** (Spike S1 de-risks): Anthropic may reject
  replayed assistant messages mixing A's signed thinking with B-origin blocks,
  or interleaved-thinking rules may require thinking before spliced tool_use.
  Mitigation: lockout rules above; worst case, splice becomes text-only.
- **Mid-message correction UX**: a visible self-correction is the honest
  rendering of an interruption, but if graders are noisy it becomes churn. The
  rubric's high bar for B plus `materially_different` gating keeps it rare;
  monitor `interrupt` rates in the reqlog.
- **CC transcript shape**: CC writes one line per assistant content block;
  spliced messages have more blocks than usual. The 2026-07-05 scrubber work
  showed CC tolerates block-count variety, but re-verify on CC version bumps.
- **Double-billing perception**: B still runs to gradable prefix after A
  delivered; that is the existing research cost made intentional. The
  delivery-mode flags and the comparison gate remain the levers if it needs
  cutting.
