# PLAN: Transparency Notices — Anthropic-Request Visibility

> Refines the display-only hook notice system
> (`plans/2026-07-05_PLAN_first_user_turn_nonblocking.md` "NOTICE DELIVERY
> UPDATE 2026-07-10"; `src/hooks.ts`, `src/notices.ts`, `src/proxy.ts`
> `handleNoticeHook`/`queueCompressionNotice`). Client-only change in this
> repo; no server work required.
>
> **STATUS 2026-07-17: PROPOSED.** Companion plan (written same day):
> `plans/2026-07-17_PLAN_speculative_ab_streaming.md`. Neither blocks the
> other; shared touchpoints listed in "Coordination" below.

## Motivation

Anthropic traffic is invisible to the user. The proxy already observes
per-request usage (`cache_read_input_tokens` / `cache_creation_input_tokens` /
`input_tokens`) into the reqlog, but the user cannot see how many requests a
turn made, whether the prompt cache was hit (the difference between a 300k
cache read and a 300k uncached prefill is the whole cost/latency story), or
which A/B legs ran. Today that requires tailing
`~/.claude-code-infinite/logs/requests.jsonl`.

Hard constraint carried forward from repo history: **Anthropic response bytes
are never rewritten, and no notice may enter stored/model-visible content.**
The sole explicit response-byte exception is opt-in speculative A/B delivery:
its SSE splice closes/renumbers blocks and adds a model-visible correction or
recovery bridge by design. Those bridge blocks are response content, not
notices; every transparency/MemTree status line below still rides the existing
hook plugin (`createSessionNoticePlugin`, `src/hooks.ts:334`) and the randomized
localhost hook endpoint (`handleNoticeHook`, `src/proxy.ts:353`).

## Current behavior (what the plumbing can and cannot do)

- **MessageDisplay** fires only when assistant output renders — after
  compress + A/B + TTFB. It can carry a prefix (index 0) or suffix (final)
  around the rendered delta (`claim`, `src/hooks.ts:172-204`). Ideal for
  after-the-fact lines.
- **Stop** fires once at end of turn; `systemMessage` output renders to the
  user only (never stored, never model-visible — `StopHookOutput`,
  `src/hooks.ts:104`). Currently the no-rendered-text fallback.
- **No hook fires between "request sent" and "first content rendered"**, so
  any live "sending…" line is unimplementable without the banned in-band
  path. All request notices are therefore retrospective.
- **Usage observation already exists everywhere**: single-leg forwards merge
  SSE/JSON usage into the turn's `MessagesRecord` (`forwardRaw` observer,
  `src/proxy.ts:2417`; `mergeUsageFromSseEvent`, `src/reqlog.ts:181`); A/B legs
  fill `ComparisonLegRecord.usage` (`BufferedUpstreamLeg.observeEvent`,
  `src/proxy.ts:2107`); the grader fills `GraderDiagnostic.usage`
  (`src/proxy.ts:1795`). Every `/v1/messages` funnels through the `logged()`
  finalizer (`src/proxy.ts:517-525`). No new parsing is needed.
- **Queue limitation**: `queuePrefix`/`queueSuffix` each *replace* the single
  pending notice (`src/hooks.ts:126-148`). New notice kinds must not clobber
  the compression/degraded notices or be clobbered by them.

## Design

**Decision (a): single after-the-fact display, no two-phase.** There is no
hook event between "request sent" and "first content rendered", and cache
status needs response usage anyway (`message_start` for SSE). So every
request line is retrospective.

**Decision (b): per-turn aggregate by default, per-request opt-in.** Tool
loops make one line per request unacceptable as a default. New env var,
parsed in `src/cli.ts` and passed through `ProxyOptions`:

- `CCC_REQUEST_NOTICES=turn` (default) — one aggregate line per completed
  main turn, delivered on **Stop** (`systemMessage`), which is the only event
  that provably follows the last tool-loop request. The existing
  `NOTICE_SETTLE_WAIT_MS` machinery already makes Stop wait briefly for
  in-flight bookkeeping.
- `CCC_REQUEST_NOTICES=all` — additionally, each **final MessageDisplay**
  appends the not-yet-reported request lines under the rendered message
  (natural rate limit: one batch per rendered assistant message); Stop
  flushes the remainder.
- `CCC_REQUEST_NOTICES=off` — feature disabled.

**Decision (c): A/B legs are labeled, all three requests count.** Labels:
`memory`, `full`, `grader`, `tool`, `user` (plain single-leg user turn),
`first` (first user turn). The aggregate marks the committed leg.

**Mechanism: a per-turn ledger rendered lazily at claim time.** New
`TurnRequestLedger` in `ProxyState`, reset where
`state.notices.clearForUserRequest()` runs today (`src/proxy.ts:402`) and on
Stop cleanup (`src/proxy.ts:455-468`), gated by the same
promptId/generation guards as existing notices. Entries are appended in the
`logged()` finalizer of `handleMessages` for main-thread requests only
(`hasAgentAttribution` excluded; `count_tokens` excluded — sidecar calls, not
completions). Crucially, an entry stores **references** to the live records —
the turn's `MessagesRecord.usage`, both `ComparisonLegRecord`s and the
`GraderDiagnostic` when `rec.comparison` exists — not copies. The notice text
is a `NoticeText` *function* (already supported: `resolveNoticeText`,
`src/hooks.ts:242`), so usage that lands late (e.g. a shadow leg under the
speculative plan) is still current when the hook claims. A leg whose usage
never arrived renders `usage n/a`. Cap: 50 entries per turn, then a single
`+N more` entry.

**Queue extension without clobbering.** `NoticeDeliveryQueue` gains an
independent slot — `pendingTransparency` — with its own
`queueTransparency(textFn, promptId)` and claim rules (final
MessageDisplay in `all` mode; Stop always), deliberately *separate* from the
replace-semantics `pending` slot so `queuePrefix`/`queueSuffix` (compression,
degraded, payment) and transparency lines can never overwrite each other.
When one hook claims both, order is: prefix, delta, suffix, transparency.
Transparency lines render dim (`\x1b[2m…\x1b[22m`, guarded by the existing
`terminalSupportsColor` flag) — informational, not celebratory green.

**Copy** (formatters in `src/notices.ts`; export the private
`formatTokenCount` for reuse):

Aggregate (default mode), examples:

```
→ Anthropic · 6 requests · cache read 1.7m · wrote 184k · uncached 14.2k
→ Anthropic · 3 requests (A/B: memory won, grader ran) · cache read 512.3k · wrote 148.9k · uncached 2.1k
→ Anthropic · 1 request · no cache · uncached 12.4k
```

Per-request (`all` mode), examples:

```
→ Anthropic (memory leg) · cache read 12.1k · wrote 88.4k · uncached 1.2k
→ Anthropic (full leg, discarded) · cache read 330.4k · uncached 95
→ Anthropic (grader) · uncached 9.3k
→ Anthropic (tool 4) · cache read 341.0k · wrote 2.2k · uncached 310
→ Anthropic (tool 5) · usage n/a
```

Cache-status rule: `cache read` shown when `cache_read_input_tokens > 0`,
`wrote` when `cache_creation_input_tokens > 0`, `uncached` is `input_tokens`;
all three zero-suppressed; entirely cacheless requests say `no cache`.

### Lifecycle (followup turn, A/B compare mode)

```
user submits prompt
  └─ UserPromptSubmit ──▶ proxy: arm state, reply 204 (unchanged)
CC sends POST /v1/messages
  └─ blocking compress (proxy.ts:651) … A/B legs + grader … winner streams
winner renders
  └─ MessageDisplay(index 0) ──▶ claims "✓ MemTree · conversation optimized …" prefix (unchanged)
tool loop: N more /v1/messages, each finalized via logged() ──▶ ledger append
turn ends
  └─ Stop ──▶ claims transparency aggregate "→ Anthropic · N requests · …"
```

## Decided trade-offs

| Decision | Rationale |
|---|---|
| Single-phase request notices | No display surface exists between send and first render; two-phase would require the banned in-band path. Cache status needs response usage regardless. |
| Aggregate default on Stop, not per-request | Tool loops routinely run 10+ requests; per-request default turns the transcript into a log viewer. Stop is the only event that provably postdates the last request of the turn. |
| Ledger holds record references, rendered at claim | Decouples notice content from delivery ordering — required for the speculative A/B plan where grader/shadow-leg usage can land after delivery. |
| Separate `pendingTransparency` slot | The existing slot's replace semantics are load-bearing (tested); merging kinds into it risks clobbering the payment/degraded notices. |
| Subagent and count_tokens requests excluded | `claim` already refuses agent hooks; showing another thread's traffic under the main transcript misattributes it. count_tokens is not a completion. |

## Implementation phases

**T1 — `src/notices.ts`:** export `formatTokenCount`; add
`requestLineText(entry)` and `requestSummaryText(entries)` pure formatters +
unit tests.

**T2 — `src/hooks.ts`:** `pendingTransparency` slot with
`queueTransparency()`, claim integration (final MessageDisplay in `all`
mode, Stop always, promptId/TTL guards identical to `pending`), dim styling.

**T3 — `src/proxy.ts`:** `TurnRequestLedger` (append in `logged()` finalizer
with label classification from `rec.turnType`/`rec.comparison`; reset on
arm/Stop); `queueTransparency` after each main-request finalization per mode.

**T4 — `src/cli.ts`:** parse `CCC_REQUEST_NOTICES` (warn-and-default on bad
values, mirroring `abEnvPositiveNumber`); thread the option into
`startProxy`.

**T5 — tests + manual verification** (below), README notice-section update.

## Test strategy

Follow the established harnesses: `armMainTurn`/`postHook`/`displayHook` in
`test/proxy.test.mjs:120-154`, the SSE leg harness in
`test/ab-routing.test.mjs:297-330`, and pure-function tests in
`test/hooks.test.mjs` / `test/notices.test.mjs`.

- **hooks.test.mjs**: transparency slot never clobbers or is clobbered by
  `queuePrefix`/`queueSuffix`; claim ordering (suffix before transparency);
  Stop claims aggregate exactly once; `all`-mode final display drains only
  unreported entries; TTL and prompt_id gating; agent hooks refused.
- **notices.test.mjs**: formatter cases — all three usage fields, zero
  suppression, `no cache`, `usage n/a`, compact formatting, 50-entry cap.
- **proxy.test.mjs**: ledger — followup + two tool turns against an SSE mock
  emitting `message_start` usage → Stop claim contains the correct sums;
  count_tokens and agent-attributed requests excluded.
- **ab-routing.test.mjs**: compare turn → aggregate labels memory/full/grader
  with the winner marked; a leg that never produced usage renders `usage
  n/a`; late-arriving grader usage visible because rendering is lazy;
  reqlog `notice claimed` records still fire once per claim.
- **Manual (staging)**: real session — ✓ still prefixes the answer, one dim
  aggregate under the turn; `CCC_REQUEST_NOTICES=all` during a tool-heavy
  turn for the per-request view; `claude -p` remains byte-vanilla (plugin not
  installed, cli.ts:314).

## Coordination with the speculative A/B plan

Touchpoints (`plans/2026-07-17_PLAN_speculative_ab_streaming.md`
"Interactions"): both plans edit around `forwardComparedSse` and the
`queueCompressionNotice` call sites (`src/proxy.ts:761,828,861,876`). This
plan deliberately avoids coupling to buffered delivery: the ledger reads
leg/grader records by reference and claims on Stop, so it is indifferent to
whether grading happened before delivery (buffered) or in shadow
(speculative). When that plan lands its new turnTypes
(`followup-ab-spliced`/`-recovered`), the ledger labels extend with
`spliced`/`recovered` and its splice suffix notice must use the *existing*
`pending` slot (it is a MemTree-outcome notice, not a transparency line).
Whichever plan merges second reconciles those two enum/label lists.

## Residual risks

- **CC version drift**: the MessageDisplay/Stop hook surfaces are
  non-contractual; re-verify on CC bumps (same standing caveat as
  MessageDisplay today).
- **Stop-vs-last-request race**: the aggregate claim could fire before the
  final tool request's `logged()` appends (sub-ms window; the A/B settle wait
  covers the compare case). Worst case the line undercounts by one request;
  the reqlog stays authoritative.
- **Spam in `all` mode** during long tool loops is user-opted-in; the default
  stays one line per turn.
- **Copy drift vs reality**: usage numbers come from Anthropic's own usage
  fields; if a future API change renames them, lines degrade to `usage n/a`
  (formatters zero-suppress and never throw) and the observer plumbing is
  the single place to fix.
