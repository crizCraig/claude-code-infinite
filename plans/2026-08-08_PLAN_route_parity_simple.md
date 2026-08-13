# Plan: one route table, every identity rides it, no byte gate

**Date:** 2026-08-08
**Status:** implemented 2026-08-09; hardened 2026-08-10 after review.
Implementation deltas from the text below: the decision-generation live set was
kept but keyed per lane (`routeDecisionsLive: Map<string, Set<number>>`) so a
subagent recovery's reservation can never mark a concurrent main install stale;
every route-installing followup now reserves its lane so reverse-order agent
completions cannot overwrite the newer route; keys use tagged JSON tuples so
opaque agent ids cannot alias reserved lanes; a pending main prompt suppresses
only main-lane recovery installation; live health evidence is aggregated across
canonical and legacy legs so a cached rescue cannot hide a live failure;
and a verdict-driven full-context outcome (A/B `full` winner, B-verdict splice)
marks its lane's blocking budget spent, so recovery cannot re-litigate a grade
that just rejected memory *(superseded 2026-08-13: the in-request A/B routing
was removed in 6defd26, so this budget mark no longer exists)*. New reqlog
values: `routeLane`, recovery outcome
`"spent"`; removed: install fates `"subagent"`/`"foreign-route"`.
**Supersedes for implementation purposes:** `plans/2026-08-08_PLAN_universal_compression_parity_opus.md`
(kept for its measurements; this plan is the smaller thing to actually build)
**Out of scope:** `count_tokens` behaviour, MemTree server changes, notices/display.

## The idea in one paragraph

Today there is exactly **one** memory-route slot, it belongs to the main thread,
and everyone else is either locked out of it or feared as a thief of it. That
single-slot assumption is what forced the two things we want gone: the
`TOOL_RECOMPRESS_MIN_CONVERSATION_BYTES = 400 * 1024` fuse (a latency guess
standing in for "is a blocking recompress worth it?") and the pile of
foreign-owner / subagent-carve-out logic that exists only to stop non-main
traffic from touching the slot. Replace the slot with a **small map keyed by
request identity**. Then isolation is structural instead of defensive, subagents
get the exact deal main gets, and the byte gate can be deleted rather than
retuned — because with routes covering the loop, a miss is rare enough that
"attempt once per identity per human turn" is a better answer than any constant.

## What changes

### 1. `state.mainMemoryRoute` → `state.memoryRoutes: Map<string, MemoryRoute>`

`src/proxy.ts:260`. The stored shape (`MainMemoryRoute`, built at
`src/proxy.ts:1845-1861`) is unchanged — it already carries `sessionId`,
`originalSystemHash`, `originalPrefixHashes`, `compressedMessages`,
`compressedSystem`, `routeEpoch`.

Key derivation:

```ts
function routeKey(req, isAwaySummary): string {
  const session = requestSessionId(req) ?? "";
  const agent = headerText(req.headers, "x-claude-code-agent-id")
    ?? headerText(req.headers, "x-claude-code-parent-agent-id")
    ?? "";
  return JSON.stringify(
    isAwaySummary
      ? [session, "away"]
      : agent
        ? [session, "agent", agent]
        : [session, "main"]
  );
}
```

The lane tag is part of the key: an agent id literally equal to `main` or
`away` is still an agent lane, and JSON tuple encoding prevents delimiter
collisions between arbitrary session and agent header values.

Three consequences fall out for free:

- **Subagents get their own lane.** They can install and ride without ever
  seeing main's entry, so the `isToolResultTurn && isSubagentRequest`
  carve-out (`src/proxy.ts:1134-1146`) and the `install: "subagent"`
  transform-only fate (`src/proxy.ts:2733`) both disappear.
- **Away-summary gets its own lane.** That closes the surviving twin of the
  2026-08-04 incident: a side request with no agent header currently keys to
  main and can evict main's route.
- **`routeMissForeignOwner` disappears** (`src/proxy.ts:1084-1090`,
  `1116-1123`, `2731-2732`). A foreign owner cannot be reached through your own
  key, so there is nothing to protect it from and no eviction ping-pong to
  prevent.

Bound the map: **32 entries, LRU by last touch** *(raised from 8 on
2026-08-13: a wide fan-out plus per-lane recovery installs could evict main's
route mid-turn at 8; do not shrink it back)*, and drop entries whose
`routeEpoch` is stale on every access. A route entry is 0.4–4 MB of heap; the
cap must be enforced, not assumed.

Every existing `state.mainMemoryRoute` read/write becomes a get/set/delete on
`routeKey(...)`. That is 14 sites, all listed by
`grep -n mainMemoryRoute src/proxy.ts`. Epoch bumps
(`src/proxy.ts:751`, `:816`, `:1026`) clear the **whole map** — a new human turn
ends the previous turn's subagents too, so per-key selective clearing would be
strictly more code for no gain.

### 2. Delete the 400KiB gate

Remove `TOOL_RECOMPRESS_MIN_CONVERSATION_BYTES` (`src/proxy.ts:139`), both size
checks (`src/proxy.ts:1162`, `:1172`) and the `conversationBytes` stringify done
solely to feed them (`src/proxy.ts:1168-1171`). Keep `conversationBytes` in the
reqlog record — compute it from the body we already have, not a second pass.

The gate answered "is this miss worth a blocking round trip?" with a constant.
Replace it with the answer main already lives by: **at most one blocking
recompress per (route key, epoch)**, tracked as a `Set<string>` of keys that
have spent their attempt, cleared alongside the map on epoch bump. Rationale:

- The followup path pays exactly one blocking compress per human turn and the
  route carries the rest of the loop. Giving every lane the same budget *is*
  parity, and it is self-limiting without a threshold.
- The existing correctness check is unchanged and is the real proof recovery
  helped: recovery only uses the result when
  `compressedRaw.length < forwardBody.length` (`src/proxy.ts:2640-2653`),
  otherwise it forwards the original.
- The two cheap pre-checks that are *not* thresholds stay:
  `hasEarlierNonToolUserMessage(messages)` (`src/proxy.ts:1154` — no earlier
  real user message means no server-side prefix can exist) and the failure
  cooldown (`src/proxy.ts:1181`, `state.toolRecoveryCooldownUntil`), which is an
  outage brake, not a size guess.

Also drop the `isMainRequest` early-return in `noteMemtreeHealth`
(`src/proxy.ts:1795`): with subagents on the same path, a subagent's compress
failure is the same evidence about MemTree's health as main's, and its successes
should clear the cooldown too.

### 3. Recovery installs for everyone

`recoverToolRouteMiss` (`src/proxy.ts:2413`) loses `foreignRouteOwner` and
`isSubagentRequest` from its argument bag and gains `routeKey`; it retains
`isMainRequest` only to scope the pending-prompt guard. `routeOwning` collapses
to "we still hold this key's epoch and decision". A sessionless request remains
transform-only (`install: "no-session"`) because a route with no session id
cannot be safely matched later. `prompt-pending` remains only for the **main lane**: a typed main prompt
merged into a tool wrapper must not install a route that vetoes the real
request, while an attributed agent's disjoint route cannot create that hazard.

`installMainMemoryRoute` → `installMemoryRoute(state, key, ...)`
(`src/proxy.ts:1820`). `memoryRoutedToolBody` (`src/proxy.ts:1865`) is
**unchanged** — it already validates content (session id, epoch, system hash,
per-message prefix hashes, `validToolRouteSuffix`) and already fails closed.
Two children attributed only by the same `parent-agent-id` deliberately share
one fallback lane. Prefix validation prevents grafting between their histories;
a mismatch rejects and rebuilds-or-forwards that shared lane. This is fallback
identity contention, not a key-encoding collision.

### 4. What is deliberately NOT in this plan

- **`count_tokens`.** The mirror at `src/proxy.ts:2788-2795` switches to the map
  lookup mechanically (same key, same guard shape) and its
  `!hasAgentAttribution(req)` gate goes away as a side effect of keying — but no
  new behaviour, no new claims about the context meter, no investigation.
- **Content-addressed routes.** Keying by content instead of identity would
  delete `sessionId` and the epoch entirely, but needs a prefix-chain hash and a
  longest-prefix lookup on every tool turn. It is the better end state and a
  strictly larger change; revisit after this lands and the logs show whether
  identity keying misses.
- **Deleting the decision-generation machinery** (`mainRouteDecisionsLive`,
  `routeDecisionHolds`, `routeDecisionCurrent`). Keep it keyed per entry. Every
  followup and route-owning recovery now reserves its lane; a no-op completion
  returns its reservation, while an install or clear commits it until the next
  epoch. This orders retries and parent-attributed siblings even when their
  async completions reverse.

## Phasing

1. **Map swap, behaviour-preserving.** Introduce `routeKey`/`memoryRoutes`,
   convert all 14 sites, keep the 400KiB gate and every existing guard. Tests
   must pass unchanged — if any test needs editing here, the swap is not
   behaviour-preserving and something was missed.
2. **Open the lanes.** Delete the subagent carve-out and the foreign-owner
   logic; subagents and away-summary install and ride their own keys.
3. **Delete the gate.** Remove the constant and both checks; add the
   one-attempt-per-key-per-epoch set; drop the `isMainRequest` gate in
   `noteMemtreeHealth`.
4. **Observability.** Add `routeLane` (`main` / `away` / agent-id-present) to
   the reqlog `MessagesRecord` so the 2,188 verbatim `tool` rows in the current
   sample can finally be split into main-miss vs subagent. Without this, step 3
   cannot be evaluated after the fact.

Each phase is independently revertable. Phase 1 is the only one that touches
many lines; 2–4 are deletions plus one field.

## Tests

- Subagent tool turn after a compressed subagent user turn logs `tool-memory`
  and forwards a routed-size body. (The acceptance signal the whole change
  exists for.)
- Main and subagent routes coexist: interleave main tool turns and subagent tool
  turns in one session; both ride, neither evicts the other.
- Same-session subagent *reject* does not evict main's entry. (This is the
  regression the old carve-out was written to prevent — it must now hold
  structurally.)
- Away-summary request leaves main's entry intact; a following main tool turn
  still rides. *(Superseded 2026-08-13: the away lane commits its decision but
  stores nothing — no tool turn or count_tokens can ever classify as away, so
  an away route is write-only heap. Do not restore the install.)*
- Small tool-route miss (well under the old 400KiB) now attempts recovery once,
  and the second consecutive miss in the same epoch does **not** attempt again.
- Recovery whose result is not smaller than the original forwards the original
  and installs nothing.
- LRU cap: 33 distinct lanes in one session leaves 32 entries *(rescaled
  2026-08-13 with the cap raise)*.
- Existing epoch/decision-generation tests in `test/proxy.test.mjs` and
  `test/ab-routing.test.mjs` pass unedited after phase 1.

## Acceptance

- No `TOOL_RECOMPRESS_MIN_CONVERSATION_BYTES` in the tree.
- `grep -c mainMemoryRoute src/proxy.ts` → 0.
- Reqlog `routeLane` present on message records; verbatim `tool` share of
  message rows falls measurably against the current 43.9% baseline, and the
  below-gate verbatim bytes (0.34 GB in the 2026-08-08 sample) approach zero.
- No blocking-compress storm: `routeRecovery.outcome` counts per human turn stay
  within one attempt per active lane.

## Honest risks

- **Recovery volume has no global bound** *(added 2026-08-13)*. The honest
  worst case: an N-agent fan-out whose lanes all miss at once is N concurrent
  blocking recovery compresses — 2N while the legacy probe still runs its
  second leg (scheduled for deletion 2026-09-15, see
  `LEGACY_PROBE_UNINDEXED_TOKENS`) — each up to
  `DEFAULT_COMPRESS_TIMEOUT_MS` = 15s, with no global concurrency bound.
  Decision: watch rather than pre-limit. The concrete tripwire: if reqlog
  `routeRecovery.outcome` counts ever show more than one attempt per lane per
  human message in production, add the already-designed hard limit — a small
  global in-flight semaphore, with excess misses forwarding verbatim without
  spending their lane's budget.
- **Latency on small misses.** Removing the gate means a genuine miss on a tiny
  body can now cost a MemTree round trip that buys nothing. The one-attempt
  budget bounds it to once per lane per human turn, and the not-smaller check
  means the payload is never worse — but the latency is real and the acceptance
  criterion above is how we'd notice it going wrong.
- **A subagent's first tool turn always misses** (its first user turn is
  first-user-shaped and installs nothing), so every subagent spends its one
  attempt immediately. That is the intended cost; it is also exactly what main
  pays.
- **Long-lived lanes drift.** A route installed early in a human turn serves a
  suffix that grows all turn. Main already has this property; parity means
  inheriting it, not fixing it here.
