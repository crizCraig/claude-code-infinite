# Tool-Turn Route Recovery (best-effort recompression + clear gating)

Status: implemented 2026-08-06; **partially superseded 2026-08-09** by
`plans/2026-08-08_PLAN_route_parity_simple.md`.
Scope: client-only changes in this repository; no MemTree server change required.

> **What this document still describes correctly:** the recovery mechanism —
> the miss classification, the blocking recompress, the smaller-body proof, the
> failure cooldown, the reservation/activation ordering, and the reqlog shape.
> That machinery is intact and is now what every lane uses.
>
> **What it no longer describes:** the single-slot design wrapped around that
> mechanism. Routes now live in a small map keyed by request identity
> (session + `main`/`away`/agent id), so every identity installs and rides its
> own lane. Consequently the `TOOL_RECOMPRESS_MIN_CONVERSATION_BYTES = 400 * 1024`
> byte gate, the main-traffic-only restrictions, and the foreign-owner
> protection described below are all **deleted**. Superseded passages are
> marked inline.

Incident: 2026-08-04 19:25:24Z, session `3ac71b3f` — one tool turn forwarded
2.96MB (976,705 input tokens) verbatim after the memory route was cleared by two
CC-internal side requests, latching Claude Code's context meter at 98% and
bricking the session. Staging logs show that MemTree was healthy throughout
(596k tokens indexed and a matching prefix available); the client did not make
a blocking recovery request.

## Decision summary

Ship two complementary protections:

1. At classification time, only a main followup request that will enter the
   blocking compression path may clear/bump the active route. A first-user-shaped
   side request may not create a clear-without-rebuild hole.
2. After a main tool request misses its local route, make one best-effort
   blocking recompression attempt when the conversation history is large.

This is a **soft recovery fuse**, not a hard payload limit. With the default
configuration, each distinct eligible miss can wait up to the existing
15-second MemTree compression budget (failures are not cached). If MemTree
fails, returns a no-op, drops history, or does not reduce the request, the proxy
still forwards the original body. That preserves today's payload behavior but
can add latency; it cannot guarantee that an oversized body is never sent while
MemTree is unavailable.

Initial rollout reuses the existing compression budget. It adds one piece of
circuit-breaker state — after an attempt returns null, the blocking attempt is
skipped for `TOOL_RECOVERY_FAILURE_COOLDOWN_MS` (60s), logged as
`routeRecovery.outcome: "cooldown"` (added in ralph-review cycle 1; the
original plan deferred it). Without it, a MemTree outage charges the full
blocking budget to *every* large tool turn rather than every human turn:
history grows each turn, so the compress-side hash dedup can never absorb the
repeat, and the fuse would be strictly worse than the verbatim path it
replaces. Any non-null response clears the cooldown. Both signals are read
from the compress result *before* either blocking path checks whether its
client is still connected (cycle 2): a null describes the server, not the
socket, and the full-budget stall that produces one is itself the likeliest
reason a client gives up — learning only from attempts that outlived their
client would blind the cooldown to precisely the outage it bounds. For the
same reason the signal is shared with the followup path, which uses the same
client and budget, so an outage first seen on a human turn does not cost
another full stall on the next tool turn.

Sharing that signal made its *provenance* matter, and cycle 3 found two ways
the shared write admitted evidence that was not about the main path's health
now. Both are resolved by ignoring weak evidence rather than guessing from it:

- ~~**Main traffic only.**~~ **Superseded 2026-08-09.** The original argument
  was that only main tool turns read the cooldown, so admitting non-main
  evidence would let an oversized subagent history arm a 60s cooldown against a
  healthy main conversation — or let a busy subagent's successes clear a
  cooldown a real outage had just armed. That reasoning depended on non-main
  traffic being excluded from recovery. It no longer is: every lane runs the
  same recovery path, so a subagent's compress failure is evidence about
  MemTree's health on exactly the terms main's is, and its successes should
  lift the cooldown for the same reason. `noteMemtreeHealth` is now
  lane-agnostic. The live-round-trip rule below still applies and is what keeps
  the shared signal honest.
- **Live round trips only.** `compress()` memoizes successes by hash and returns
  them without contacting the server, so cached legs contribute no current
  health evidence. Any live success clears the cooldown and wins over a
  simultaneous live failure; with no live success, any live failure arms it.
  This includes a live canonical failure rescued by a cached legacy result —
  the cached winner must not conceal current outage evidence. An in-flight leg
  counts as cached (discarding live evidence only forgoes an optimization).

A shutdown-aborted compress maps to the same null as a server failure and now
arms nothing, so a drain is not recorded as a MemTree outage. Classification gating
should make recovery exceptional, while a temporary `CCC_TOOL_ROUTE_RECOVERY=0`
kill switch provides fast rollback on relaunch. Use the new telemetry to
revisit the wait budget or cooldown length against real latency data.

Expose the switch to embedders as `ProxyOptions.toolRouteRecovery?: boolean`
(default `true`); the CLI maps an environment value of `0` to `false` when the
process starts.

## Current failure

In `handleMessages`, a main tool turn currently has only two outcomes:

1. `state.mainMemoryRoute` exists and `memoryRoutedToolBody` accepts it: rewrite
   the prefix locally (`tool-memory`) and forward a reduced body.
2. The route is missing or rejected: forward the full body (`tool`) and start
   only background indexing. There is no request-path recovery.

Separately, the classification-time invalidation immediately before the
`!isFollowupUserTurn` branch currently runs for every main
`isCompressibleUserTurn`. That includes first-user-shaped CC side requests,
which take the nonblocking/background path and cannot rebuild what they clear.

## Fix 1 — gate classification-time invalidation to rebuilders

In `handleMessages`, change only the classification-time guard:

```ts
if (isCompressibleUserTurn && isMainRequest) {   // before
if (isFollowupUserTurn && isMainRequest) {       // after
```

Precise invariant: **at this classification point**, only a main request that
will enter blocking compression may bump `mainRouteEpoch` and clear
`mainMemoryRoute`. Lifecycle and delivery-decision invalidations remain
unchanged: `UserPromptSubmit`, `Stop`, route rejection, MemTree degradation,
and a delivered full-history A/B choice may still clear intentionally.

This is safe because `memoryRoutedToolBody` revalidates the session id, epoch,
normalized system hash, every original prefix hash, and the tool-only suffix
before rewriting. Retaining a route across an unrelated first-user-shaped side
request therefore cannot graft it onto that request or another conversation;
it can only match the exact conversation extension or fail closed later.

The `UserPromptSubmit` clear stays. It represents intent to begin a new human
turn, not turn-shape classification. If no rebuilding request follows, the
best-effort miss recovery below protects a later large tool request.

## Fix 2 — share the complete blocking-compression pipeline

Do not copy only the `opts.memtree.compress(...)` call into the tool branch.
Extract a private helper from the existing followup path and keep that path
behavior-preserving. The shared helper must own the current complete selection
pipeline:

- system-inclusive input plus `normalizeMessagesForMemtree`;
- canonical and legacy hashes, conversation-scoped migration probing, and
  legacy fallback selection;
- `modelForMemtree`, model context limit, and `tools` budget metadata;
- `state.shutdownSignal` (never a per-request disconnect signal, because a
  hash-deduped compression promise can serve another live request);
- per-leg timing needed for `compress.ms`, `compress.ok`, `compress.timedOut`,
  and `compress.legacyFallback`;
- the exact input shape against which the winning result must be checked.

Return enough information for either caller to apply both required guards:

```ts
didMemtreeCompress(result) &&
checkCompressedHistory(result, winningInputMessages).usable
```

A non-null 200 response is not sufficient. It can be an index-warming no-op,
and flattening that response would change structured conversation history. An
indexed response can also contain too little prior context. Both cases must
preserve the original body and must not create a route.

Use one shared body builder for the existing followup and new recovery paths:
lift any returned system message to `body.system`, then run
`flattenToSingleUserMessage(result.messages)` for `body.messages`. The route
candidate must be created from this final `compressedBody`, not raw
`result.messages`.

## Fix 3 — recover a large `/v1/messages` tool-route miss

Place recovery in the current `!isFollowupUserTurn` branch, immediately after
the local route lookup and before `recordTurn`, background indexing, and
`forwardRaw`.

### Eligibility

Attempt recovery only when all conditions hold:

- tool route recovery is enabled;
- ~~`isToolResultTurn && isMainRequest`~~ → **`isToolResultTurn`, any lane**
  (superseded 2026-08-09);
- no local rewrite was produced, because the route was either missing or
  rejected;
- `hasEarlierNonToolUserMessage(messages)` is true, so a server-side prefix can
  plausibly exist;
- ~~the serialized non-system conversation `messages` … are at least
  `TOOL_RECOMPRESS_MIN_CONVERSATION_BYTES = 400 * 1024` bytes.~~
  **Superseded 2026-08-09: the byte gate is deleted.** In its place, a lane may
  spend **one** blocking attempt per epoch (`toolRecoveryAttemptedLanes`,
  cleared with the route map on every epoch bump), any request size.

> **Superseded 2026-08-09 — why the byte gate went away.** The threshold was a
> byte gate, not a tokenizer guarantee: 400KiB is roughly 100k–140k tokens under
> this repository's approximations, measured on conversation bytes rather than
> `forwardBody.length` so a large system or `tools` schema with a short
> transcript would not buy blocking latency. It answered "is this miss worth a
> blocking round trip?" with a constant, and that constant existed because a
> single slot meant misses were common. With every identity riding its own lane
> a miss is rare, so the honest budget is the one main already lives by — at
> most one blocking recompress per (lane, epoch) — which is self-limiting
> without a threshold and gives every lane parity. `conversationBytes` survives
> as a reqlog measurement, taken once per attempt rather than to feed a gate.
> The full post-transform body comparison below is unchanged and is still the
> final proof that the actual Anthropic request became smaller.

Capture the miss reason before any eviction. ~~On rejection, evict the route only
when the request has the same nonempty session id: that is a real same-session
system/prefix/suffix mismatch that the recovery can rebuild. A request with a
missing or different session id cannot use this slot, but it must not destroy a
route that may still serve its owner. A successful, protocol-complete recovery
for a different identified session may later replace the single slot normally.~~

> **Superseded 2026-08-09.** The same-session eviction test protected the one
> shared slot from a foreign owner. Keying removes the reachability that made
> the protection necessary: a request can only ever reach its own lane, so a
> rejection evicts only its own entry and no other identity's route is exposed
> to it. `routeMissForeignOwner`, `foreignRouteOwner`, and the `"foreign-route"`
> install fate are deleted. Two identities that collide on a key (siblings
> sharing only a `parent-agent-id`) are handled by `memoryRoutedToolBody`'s
> existing content validation, which fails closed — not by a guard.

A route hit remains unchanged and still takes the local, nonblocking
`tool-memory` path.

### Compression result

Track downstream closure during compression exactly as the followup path does.
Let the shared MemTree operation finish for cache/index value, but if the client
has disconnected, do not start an Anthropic request and do not install a route.

After actual-compression and usable-history validation, build `compressedRaw`
and require `compressedRaw.length < forwardBody.length`. A result with no byte
gain does not serve the payload-recovery goal: forward the original body and do
not install it as a route.

After any non-null MemTree response, do not also call `indexInBackground` for
that request: the context-memory call already submitted the history. After a
`null` caused by an ordinary server/network failure or timeout, retain the
background index submission; its longer independent budget can still warm the
index for a later turn. Skip that retry on shutdown, 402/payment failure, or an
already-closed client. Route hits, ineligible misses, disabled recovery, and
below-threshold misses retain today's background-index behavior.

### Forwarding and activation

For a validated, smaller result:

- forward exactly one compressed Anthropic leg with `forwardRaw`; never enter
  A/B comparison, because launching or selecting a full-history leg defeats
  the recovery;
- do not queue a notice, consume `mainPromptArmed`, mark
  `mainPromptDelivered`, or otherwise claim human-turn state;
- create a route candidate, but do **not** install it merely because MemTree
  succeeded;
- activate it with the same successful-protocol-complete callback used by the
  normal single-memory path: a complete 2xx JSON response or an accepted SSE
  `message_stop`, with delivery completion retained as a defensive fallback;
- do not activate the candidate after a 500/529, incomplete response, shutdown,
  or client disconnect before protocol completion. A different-session route
  preserved at lookup remains untouched. A candidate activated at
  `message_stop` may deliberately survive a later downstream-close result so
  an immediate tool request cannot race the HTTP `finish` event.

Installation additionally requires a nonempty request session id. A request
without `x-claude-code-session-id` may still receive a one-shot smaller body,
but it cannot self-heal the route and must never clear a concurrently installed
route by calling `installMainMemoryRoute` with an unavailable identity.

### Async ordering and prompt ownership

The existing epoch check protects against a later human-turn invalidation but
does not order two tool recoveries that start under the same epoch, or a tool
recovery against an already-running followup. Add a monotonic
`mainRouteDecisionGeneration` to `ProxyState`. Every request that can
asynchronously own a route reserves and captures a new generation: every
followup on every lane, plus an eligible tool recovery that has a session id
and no pending **main-lane** prompt arm. Every route install **and every
post-await route clear** requires both its captured `mainRouteEpoch` and
decision generation still to match. This includes the existing degraded,
no-op, empty-memory, non-A/B, and A/B callback paths, so an older completion
cannot erase or overwrite a newer decision.

A reservation is taken before its outcome is known, so one that ends up
mutating nothing must be **returned** (cycle 1) — otherwise a failed, no-op,
no-gain, or client-closed recovery silently suppresses a concurrent followup's
install and the conversation ends up with no route at all. Live reservations
are therefore tracked as a set rather than by comparing against the counter
(cycle 2): releases can arrive out of order, and a "release only if I am the
newest" rule cannot move a counter that a newer sibling already advanced, so
the older reservation's slot leaks and strands every older holder permanently.
A holder is current while no strictly newer reservation is live; an install or
clear keeps its reservation forever, which is what stops a slower older
decision from overwriting it. The set is cleared on each epoch bump, where
every surviving entry is already epoch-stale — that also bounds its growth to
one human turn's decisions.

A sessionless or prompt-pending one-shot recovery cannot install a route and
therefore does not advance the decision generation. Do not bump
`mainRouteEpoch` from a tool recovery, because that epoch also guards human
prompt delivery/retry state.

Capture whether the recovery is route-owning at its start. If a main request
sees a pending human prompt arm (`mainPromptArmed`), the attempt is permanently
transform-only: it reserves no generation and may
not activate even if that window happens to close before its response. The
current recovery-turn classifier uses route existence and message-count growth
as an early rideability signal; an intermediate tool wrapper must not install a
route that vetoes classification of the later real merged-prompt request. The
one-shot compressed forward is still allowed and remains prompt-state-neutral.
An attributed agent uses a disjoint route key, so the main arm does not make
its recovery transform-only.

The window is the **arm only**, deliberately narrower than the followup path's
`mainPromptArmed || !mainPromptDelivered` (cycle 3). `mainPromptDelivered`
means "the response stream flushed", which is strictly stronger than "the
client received the message": the documented fast-tool abort — Claude consumes
`message_stop`, drops the SSE, and immediately sends its tool request — is a
normal success that leaves the flag false until `Stop`. Keying recovery off
that window meant one such abort plus one later route rejection made every
subsequent large tool turn transform-only: a full blocking compress per tool
turn, no route ever installed, and no cooldown to bound it because every
attempt *succeeded*. Hookless embedders, where nothing sets the flag after the
first undelivered turn, were stranded the same way.

Dropping that half is safe because the merged-prompt hazard cannot coexist
with a main tool-result turn: being in recovery at all proves a main response
reached the client and produced a `tool_use`. The only undelivered prompt that
could still arrive merged into a tool_result wrapper is one whose request has
not been classified yet — exactly what the arm marks. An unflushed 5xx retry
is likewise unreachable, since that client holds no new `tool_use` to send
meanwhile, so no recovery can install a route that would veto the retry's
recovery-prompt classification.

## Fix 4 — make recovery observable

In `src/reqlog.ts`:

- add `"tool-recompressed"` to `TurnType`, used only when validated compressed
  bytes are actually sent to Anthropic;
- add `routeMiss?: "missing" | "rejected"` to `MessagesRecord`, emitted only
  for main tool turns that attempted local route lookup. Optional absence means
  there was no applicable miss; `"none"` is therefore not a valid value;
- add an optional structured recovery diagnostic:

```ts
routeRecovery?: {
  conversationBytes: number;
  outcome:
    | "compressed"
    | "failed"
    | "noop"
    | "unusable"
    | "no-gain"
    | "client-closed";
  install?:
    | "installed"
    | "stale"
    | "prompt-pending"
    | "no-session"
    | "upstream-failed";
};
```

Failed, no-op, unusable, no-gain, and pre-forward client-close attempts remain
`turnType: "tool"`; `compress` and, when available, `history` retain their
existing meanings. In particular, `compress.ok` means that a non-null MemTree
result returned, not that compressed history was forwarded.

Update comments in `src/proxy.ts` and `src/memtree.ts` so they no longer claim
that every tool turn is background-only or forwarded as-is. Document the
recovery behavior and temporary kill switch in README.

## Tool-tailed compression evidence and remaining integration check

The reviewed server implementation has no last-message shape assumption. It
hashes each prefix, selects the longest completed index, and carries messages
after that prefix as the unindexed tail. The incident's 19:24:35Z staging logs
show an index-only call with the exact tool-tailed body matching a
1173-of-1223-message prefix.

Reviewed MemTree server evidence (recorded 2026-08-06): repo
`polychat-cc-api-model-based-index-budget` at commit
`84ddc36db48f18208ac46192455255a8c5455822` (2026-08-03, clean tree) —
`generate_messages_hash_sequence` (`polychat/memory/history_job.py:337`),
`check_for_existing_indexes`, and `get_unindexed_messages`
(`history_job.py:519` slices `messages[message_count:]` as the verbatim tail
with no last-message shape assumption).

Client-side `checkCompressedHistory(...).usable` validates retained history;
it does not validate Anthropic tool-protocol semantics. The shared body builder
deliberately flattens the complete MemTree result into one user message, as the
existing merged-tool-result recovery path already does, so it does not send an
orphaned structured `tool_result`. A required staging smoke test must still
confirm all of the following with a real tool-tailed response:

- MemTree returns an actual, usable compression and preserves the current tool
  tail in the flattened result;
- the final transformed Anthropic request receives a 2xx response rather than
  a `tool_use`/`tool_result` protocol error;
- the subsequent tool request rides the newly activated route.

## Verification plan

### Automated tests

Add focused cases in `test/proxy.test.mjs` (and update reqlog type/schema tests
where applicable):

Classification and gates:

- Install a route, send an unrelated first-user-shaped side request with the
  **same session id** and no `UserPromptSubmit`, then verify the next real tool
  turn still logs `tool-memory` and both `/messages` and `/count_tokens` use the
  compressed prefix.
- ~~Missing route and rejected route each trigger recovery at or above the exact
  conversation threshold; below-threshold and no-earlier-user requests do not.~~
  **Superseded 2026-08-09:** missing and rejected each trigger recovery at any
  size, once per lane per epoch; the second miss in the same epoch logs
  `routeRecovery.outcome: "spent"` and forwards verbatim. No-earlier-user
  requests still do not trigger.
- ~~A large top-level/ambient system or `tools` schema with small conversation
  history does not trigger.~~ **Superseded 2026-08-09:** no size gate exists to
  mis-fire, so there is nothing to exclude.
- ~~Subagent-attributed and away-summary requests never trigger.~~
  **Superseded 2026-08-09 — inverted.** Both now trigger on their own lane, and
  that is the acceptance signal the route-parity change exists for: a subagent
  tool turn after a compressed subagent user turn must log `tool-memory` and
  forward a routed-size body, and an away-summary must install on the `away`
  lane while leaving main's entry intact.
- `CCC_TOOL_ROUTE_RECOVERY=0` preserves current background-index/verbatim
  behavior.

Result validation and forwarding:

- A usable actual compression forwards the smaller body as
  `tool-recompressed`; the following tool turn and count request ride locally.
- `null`, 200/no-op, compressed-but-unusable, and no-byte-gain results forward
  the original stripped body and install no recovered candidate.
- The final flattened recovery request contains the exact current tool name,
  `tool_use` id/input, and matching `tool_result` id/content from a controlled
  fixture.
- A legacy fallback result uses the correct history-check input and retains
  `compress.legacyFallback` telemetry.
- A non-null blocking recovery may issue its normal canonical and legacy-probe
  legs but adds no `indexInBackground` call. A `null` ordinary failure adds the
  deliberate longer-budget background retry; shutdown, 402, and client-close
  cases do not. Ineligible paths retain background indexing.
- With A/B enabled, recovery launches one compressed Anthropic request, no
  full-history leg, no grader, and no notice.

Lifecycle and races:

- A successful JSON response and SSE `message_stop` activate the route; a fast
  tool request immediately after `message_stop` rides it.
- Upstream 529, truncated SSE, proxy shutdown, and client close during
  compression or before protocol completion do not activate the candidate and
  preserve any identity-mismatched pre-existing route. A close during
  compression starts no Anthropic request.
- A human hook bump during compression prevents stale installation.
- Two differently hashed recoveries started under one epoch and completed in
  reverse order obey `mainRouteDecisionGeneration`; the older completion
  cannot overwrite the newer candidate.
- An older normal followup completion cannot install or clear after a newer
  identified tool recovery reserved the route decision generation, and the
  converse ordering is covered as well.
- `UserPromptSubmit` -> large intermediate tool wrapper -> real merged-prompt
  wrapper preserves prompt/recovery classification, notice ownership, and
  delivery state; the one-shot wrapper does not advance the route decision or
  strand the real followup's later activation.
- A sessionless request can receive one-shot compression but cannot install a
  recovered route; its late activation cannot clear a route installed after
  the miss began.
- A missing/different-session rejection preserves the existing slot, while a
  same-session shape/hash/suffix rejection evicts it and can rebuild it.

Logging and Count Tokens:

- `routeMiss`, `routeRecovery`, `compress`, `history`, forwarded bytes, and
  `tool-recompressed` semantics match the definitions above. Successful local
  hits and non-main tools omit miss/recovery fields.
- The incident regression proves that Fix 1 preserves the installed route for
  the next `/count_tokens` request; no count-token miss recovery is added here.

Run `npm test` (build plus the complete test suite), not only the focused file.

### Pre-release staging smoke

Replay the incident-shaped tool-result tail against staging
`/v1/context_memory`, pass the transformed request through a real Anthropic
tool continuation, and verify route riding on the next tool and count-token
requests. Force a controlled tool choice (or synthesize a valid next request
from the returned `tool_use` id) so route riding is deterministic rather than
depending on the model voluntarily calling a tool. Record request sizes,
MemTree latency, response status, route activation, and the pinned server
revision.

After enabling by default, inspect the always-on request log for recovery
success rate, p50/p95 `compress.ms`, timeouts, repeated misses, bytes saved,
activation suppression, and new upstream 4xx responses. These logs are local,
so rollout measurements come from controlled staging/canary hosts. Before
default enablement, record numerical rollback thresholds; require zero
attributable tool-protocol 4xx responses, a recovery timeout rate below 5%, and
p95 `compress.ms` at or below 5 seconds over at least 20 eligible canary
attempts. On a breach, set `CCC_TOOL_ROUTE_RECOVERY=0` and relaunch.

## Why no route cache in this fix

A bounded cache keyed by session and agent identity is technically feasible.
`UserPromptSubmit` already carries a required `session_id`, and hook inputs can
carry `agent_id`; the previous claim that the hook had no usable session key was
incorrect.

~~It is still deferred~~ **Deferral closed 2026-08-09** — the keyed route map
shipped as `plans/2026-08-08_PLAN_route_parity_simple.md`. The deferral was
correct at the time and its cost estimate was largely right: the change did need
eviction (8-entry LRU) and fallback identity for partially attributed requests
(`x-claude-code-agent-id` falling back to `x-claude-code-parent-agent-id`, then
`main`). Keys are tagged JSON tuples, keeping reserved `main`/`away` lanes
distinct from opaque agent ids. Per-key epochs were
unnecessary — a new human turn ends the previous turn's subagents too, so the
single epoch bump clears the whole map. Prompt ownership stays main-only, while
activation ordering is per lane: every followup and route-owning recovery
reserves its own key, so a subagent's reservation cannot mark a concurrent main
install stale and reverse-order same-lane completions cannot overwrite newer
routes.

The rest of the paragraph's reasoning still holds and is worth preserving: the
cache does **not** subsume Fix 1. A same-session, main-shaped side request
clearing the main entry is a *clear-without-rebuild* hazard, which keying does
not address — a request that keys to `main` and cannot rebuild what it clears is
still a hole, which is why the classification gate remains. What keying did solve
is the *other* half of that incident, the side request with no agent header that
could evict main's route: it now lands on the `away` lane instead. And the
"larger payoff", subagent route riding, is exactly what shipped.

## Non-goals and residual risk

- A hard local payload cap when MemTree is unavailable. Failure still degrades
  to the original body after the configured blocking budget.
- A new recovery-specific *timeout*; the shared compression budget still bounds
  each attempt. (The failure *cooldown* this section originally deferred was
  added in ralph-review cycle 1 — see the decision summary — because the fuse
  pays per tool turn, not per human turn.)
- ~~LRU/multi-slot route storage or subagent route riding.~~ **No longer a
  non-goal — shipped 2026-08-09** as an 8-entry LRU map keyed by request
  identity (`plans/2026-08-08_PLAN_route_parity_simple.md`).
- Request-path recovery for a `/count_tokens` route miss. There is no captured
  evidence that such a preflight preceded this incident, and adding it would
  require caller-specific telemetry plus budget-metadata-safe compression-cache
  identity. If a trace shows full-history counting triggers auto-compaction
  before `/v1/messages`, implement transform-only count recovery separately;
  it must never install a route.
- Changing UserPromptSubmit/Stop invalidation or the meaning of
  `mainRouteEpoch`; async route decisions use a separate generation.
- Any server API or indexing-algorithm change.
