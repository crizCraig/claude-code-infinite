# Problem: Non-main traffic does not get MemTree compression parity

**Date:** 2026-08-08  
**Status:** **resolved 2026-08-09** by `plans/2026-08-08_PLAN_route_parity_simple.md`
(identity-keyed route map; 400KiB gate deleted). The diagnosis below is
preserved as written — it is the reasoning that motivated the fix.  
**Related:** `plans/2026-08-04_PLAN_tool_turn_route_recovery.md` (the design this
report critiques; now partially superseded),
`plans/2026-08-08_PLAN_universal_compression_parity_opus.md` (the alternative
content-addressed answer, not implemented)

## Product intent

`ccc` exists so conversations can run endlessly: MemTree shrinks what Anthropic
sees, and Claude Code's context meter must track that shrunk size — not the raw
transcript on disk. That intent is not "main human turns only." **Any request
that carries conversation history** — main tool loops, subagents that share or
fork context, away-summary, and other Claude Code side requests — can grow past
the model window and must be able to use MemTree. Excluding a class of traffic
from compression recreates the brick the product is meant to prevent.

Isolation still matters: a side request must not clear or overwrite another
conversation's local shortcut. Isolation is not an excuse to forward full
history.

## Who decided 400KiB?

`TOOL_RECOMPRESS_MIN_CONVERSATION_BYTES = 400 * 1024` was introduced in the
**tool-turn route recovery** design (`plans/2026-08-04_PLAN_tool_turn_route_recovery.md`)
and landed with commit `9f175f1` ("Tool-turn route recovery: miss fuse, clear
gating, observability").

It is **not** a MemTree or Anthropic limit. It is a **client-side latency gate**
on the soft recovery fuse:

- Only when serialized non-system conversation bytes are ≥ 400KiB does a
  tool-route miss pay for a blocking MemTree recompress (up to the shared
  ~15s compress budget).
- Below that, the proxy forwards verbatim — the plan's judgment was that
  smaller bodies are "cheap enough" not to stall the tool loop.
- The plan approximates 400KiB ≈ **100k–140k tokens** under this repo's usual
  byte→token heuristics. It is explicitly a byte gate, not a tokenizer
  guarantee. Final proof that recovery helped is still
  `compressedRaw.length < forwardBody.length`.

So 400KiB answers: "when is a **miss recovery** worth blocking?" It does **not**
answer: "when should a conversation use MemTree compression at all?" Main-thread
followups compress without that gate; the local memory route then carries the
tool loop for free. Subagents and CC side requests never got that second half.

## Symptom

Traffic that is not the "main" human turn is gated out of the local compression
model (`isMainRequest = !isAwaySummary && !isSubagentRequest`), even when it
carries (or forks) the same long history MemTree already indexes:

| Path | Main | Subagent | Away-summary / other CC side requests |
|------|------|----------|----------------------------------------|
| Followup-shaped turn → blocking compress | Yes | Yes (compress runs) | Often classified away from main rebuild path; may forward large history |
| Install local shortcut (`mainMemoryRoute`) | Yes | **No** | **No** |
| Tool / continuation rides local compressed prefix | Yes (`tool-memory`) | **No** | **No** |
| Large tool miss → blocking server recovery | Yes (may reinstall route) | Transform-only after recent change, still ≥ 400KiB | **No** (plan: "never trigger") |
| Matching `count_tokens` sizes compressed body | Yes (route mirror) | **No** (`!hasAgentAttribution`) | **No** |

The 2026-08-04 incident was itself a side-request story: CC-internal
first-user-shaped calls cleared the main route without rebuilding it, then a
tool turn forwarded ~977k tokens. Fix 1 stopped the clear-without-rebuild hole.
It did **not** make side requests and subagents *use* MemTree the way main does
for endless context.

Practical effect:

1. **Anthropic `/v1/messages`:** After a compressed main or subagent user turn,
   tool steps and side requests can still resent full history. Large subagent
   misses can now one-shot recompress, but every such turn either pays full
   payload or another blocking MemTree round-trip — never the cheap local splice
   main gets. Away-summary and similar calls remain off the recovery path
   entirely.
2. **`count_tokens`:** Still counts the raw body for non-main traffic. Claude
   Code sizes context from that reply, so it can show "context full" /
   auto-compact even when MemTree already shrunk a related `/messages` call —
   the same class of bug the main route was invented to prevent.
3. **400KiB asymmetry:** Main tool turns usually **never hit** the 400KiB fuse
   because they ride the route. Non-main traffic that only gets compression
   through that fuse (or not at all) treats a rare safety net as its primary
   path — so a threshold chosen to avoid stalling small main misses denies
   compression to mid-size loops and side calls that already have a server-side
   prefix.

Billing clarification: Anthropic charges the forwarded `/messages` body, not the
`count_tokens` number. The metering bug is still severe; full forwards are also
real cost/latency.

## Root cause (design, not a one-line bug)

Compression is split into two mechanisms:

1. **Server index (MemTree)** — content-addressed prefix hashes; works for
   branches, rewinds, and shared/forked stems.
2. **Local route (`mainMemoryRoute`)** — single slot on `ProxyState`, installed
   only for main, mirrored into tool + `count_tokens` for the rest of the human
   turn.

Non-main traffic was excluded from (2) so it could not clear or overwrite the
main shortcut (subagents share `x-claude-code-session-id`; side requests were
the clear-without-rebuild hazard). Transform-only subagent recovery reuses (1)
without owning (2). That stops some full-history blowups above 400KiB but is
**not** product parity: main's steady state is local route-riding; everyone else
is miss → optional blocking recompress → no sticky prefix → `count_tokens`
still full — or no MemTree path at all.

The 400KiB constant is a secondary amplifier: it was scoped for (2)'s miss fuse,
then became the on-ramp for whoever is denied a sticky route.

## Why "just lower 400KiB" is insufficient

Lowering or removing the gate for non-main traffic would mean more blocking
MemTree calls per request (and still no `count_tokens` mirror). Main avoids that
cost because the route makes continuations non-blocking. Parity requires a
**sticky compressed prefix per conversation identity** (agent / side-request
key / main) plus count-token mirroring — not only a cheaper fuse. Side requests
must compress **without** being allowed to demolish another identity's slot.

## Desired outcome

Every history-carrying request should use the **same compression model as main**,
with isolation by identity:

1. After a successful compressible turn (or recovery), install a route keyed by
   conversation identity (main vs `agent_id` vs other stable attribution) — not
   a single process-global main slot.
2. Subsequent tool turns, side continuations, and `count_tokens` for that
   identity ride the compressed prefix locally when prefix/suffix checks pass.
3. Away-summary and other CC side requests that embed long history must go
   through MemTree (transform-only at minimum; sticky route when they loop)
   so they cannot be the request that bricks an endless session.
4. Miss recovery remains a safety net — not the only way non-main traffic ever
   shrinks — with a gate chosen for rare misses once routes exist per identity.
5. Identities stay isolated: one request must never clear, overwrite, or ride
   another's shortcut unless prefix identity truly matches (fail closed).

## Non-goals (for this problem statement)

- Changing MemTree server APIs or indexing.
- Hard local payload caps when MemTree is down.
- Showing another thread's traffic as main-transcript notices (display
  attribution stays separate from compression).

## Acceptance signals

- Subagent tool turn after a compressed subagent user turn logs `tool-memory`
  (or equivalent) and forwards a body comparable to main's routed size.
- Away-summary / CC side requests that carry large history are MemTree-reduced
  (or safely route-ridden) rather than verbatim full transcript.
- `count_tokens` for that identity in the window reports the compressed size,
  not full history.
- Main session under concurrent subagent or side traffic still rides its own
  route; regression: same-session non-main reject must not evict main.
- Reqlog distinguishes identity-owned install/ride from main and from
  transform-only one-shots.

## References

These point at the code **as it was when this report was written**. All five
were changed by the 2026-08-09 fix; each is annotated with where it went.

- Constant: `TOOL_RECOMPRESS_MIN_CONVERSATION_BYTES` in `src/proxy.ts` —
  **deleted.** Replaced by one blocking attempt per (lane, epoch),
  `state.toolRecoveryAttemptedLanes`.
- Plan rationale: `plans/2026-08-04_PLAN_tool_turn_route_recovery.md`
  ("Eligibility", "Why no route cache in this fix", incident: side-request
  clear) — **partially superseded**; that document now carries inline markers.
- Count-tokens mirror (main only): `handleCountTokens` +
  `!hasAgentAttribution(req)` — **gate removed.** `handleCountTokens` now does
  the same keyed lookup as the messages path, so an agent's count reflects its
  own lane's compressed size.
- Main gate: `isMainRequest = !isAwaySummary && !isSubagentRequest` in
  `src/proxy.ts` — **still present, but no longer gates compression.** It now
  scopes only the main-thread lifecycle concerns it always should have: prompt
  arm ownership, notice display, A/B routing, and the epoch bump.
- Deferred multi-slot / subagent route riding: same plan, non-goals /
  "Why no route cache in this fix" — **shipped** as an 8-entry LRU map keyed by
  session + lane.

Coverage of the acceptance signals above, as of 2026-08-09:

| Signal | Status |
| --- | --- |
| Subagent tool turn rides after a compressed subagent user turn | Covered — `test/proxy.test.mjs`, "a compressed subagent followup installs its own lane and its tool loop rides" |
| Away-summary reduced rather than verbatim | Covered — "an away-summary followup installs on the away lane and spares main's route" |
| `count_tokens` for that identity reports the compressed size | **Behaviour shipped, not yet tested.** The `!hasAgentAttribution(req)` gate is gone and `handleCountTokens` keys the same way `/v1/messages` does, but every existing `count_tokens` test drives the main lane. An agent-lane count is unproven. |
| Main still rides under concurrent subagent traffic; same-session non-main reject does not evict main | Covered — "a same-session subagent reject evicts only its own lane, never main's" |
| Reqlog distinguishes identity-owned install/ride | Covered — `routeLane` asserted across the lane tests; transform-only now survives only for `no-session` and a `prompt-pending` **main** lane |
