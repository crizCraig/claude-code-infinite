# Spec: universal compression parity via a content-addressed prefix cache

**Date:** 2026-08-08
**Status:** **not implemented — superseded 2026-08-09** by
`plans/2026-08-08_PLAN_route_parity_simple.md`, which shipped instead.
Retained for its measurements and its audit of the pre-change code, both of
which are still the best record of why the change was needed.
**Answers:** `reports/2026-08-08_PROBLEM_subagent_compression_parity.md`
**Line references** are to the working tree as of 2026-08-08 (which contains
uncommitted ralph-review cycle-3 work), not to `HEAD` — and that tree no longer
exists. Every `src/proxy.ts:NNNN` citation below is stale; treat them as
archaeology, not navigation.

> **What shipped instead, and why.** This spec proposed **content-addressed**
> routes: a prefix-chain hash with longest-prefix lookup, which would delete
> `sessionId` and the epoch entirely. The plan that shipped keys by **identity**
> (session + `main`/`away`/agent id) — strictly smaller, no new hashing or lookup
> on the tool path, and enough to give every lane parity. Content addressing
> remains the better end state and is explicitly deferred, not rejected: revisit
> once the `routeLane` telemetry shows whether identity keying misses in
> practice. The two specs agree on the diagnosis and on deleting the 400KiB
> gate; they differ only in the key.

---

## 0. The one-paragraph version

The problem report is right that non-main traffic does not get compression
parity, and right that the cure is a sticky compressed prefix rather than a
cheaper fuse. It is wrong about *what to key the prefix on*. It proposes a map
keyed by **conversation identity** (main / `agent_id` / side-request key).
Identity is the most brittle input this proxy has — it is inferred from
undocumented Claude Code headers and message shapes, and identity
misclassification is the direct cause of the 2026-08-04 incident. This spec
proposes keying on **content** instead: a bounded cache of compressed prefixes
addressed by the hash of the prefix they replace. The route validator is
*already* content-addressed (`memoryRoutedToolBody`, `src/proxy.ts:1865-1905`,
checks the system hash and every prefix message hash and fails closed); only
the *storage* is a single identity-owned slot. Changing the storage and
deleting identity from the correctness path delivers parity for every traffic
class at once, dissolves the epoch/generation machinery instead of replicating
it per key, and makes the 2026-08-04 failure mode structurally impossible
rather than gated against.

---

## 1. Validating the problem report's premises

The user asked for the report's premises to be checked. Most hold. Four do
not, and the corrections change what should be built.

### 1.1 Confirmed

| Premise | Verdict | Evidence |
|---|---|---|
| `TOOL_RECOMPRESS_MIN_CONVERSATION_BYTES = 400 * 1024` is a client-side latency gate on the miss fuse, not a MemTree or Anthropic limit | **Confirmed** | `src/proxy.ts:139`; gate applied at `:1162`, `:1172` |
| `isMainRequest = !isAwaySummary && !isSubagentRequest` | **Confirmed** | `src/proxy.ts:960` |
| Only main installs / rides / mirrors the local route | **Confirmed** | install `:1443`; ride `:1092`; count_tokens mirror `:2787-2800` |
| Subagents never touch `state.mainMemoryRoute` at all | **Confirmed** | every read and write site is `isMainRequest`-guarded |
| `count_tokens` for a subagent counts the raw body | **Confirmed** | `!hasAgentAttribution(req)` gate at `src/proxy.ts:2790` |
| Subagents share the main thread's `x-claude-code-session-id` | **Confirmed** | `src/proxy.ts:451-461`; this is why `legacyMigrationKey` folds in agent id |
| The 400KiB asymmetry is real — main rarely hits the fuse, non-main depends on it | **Confirmed** | see §1.3 for the measured shape |

### 1.2 Corrected — the report overstates the gap

**(a) Away-summary already gets full MemTree compression.** The report's table
row says away-summary is "often classified away from main rebuild path; may
forward large history", and desired outcome #3 asks that it "must go through
MemTree (transform-only at minimum)". That work is already done.
`isFollowupUserTurn` carries **no** `isMainRequest` gate
(`src/proxy.ts:1001-1003`, verified directly). An away-summary request is a
plain user message with earlier user history, so it is followup-shaped, reaches
`runBlockingCompression` at `src/proxy.ts:1275`, and forwards a compressed
body. It neither clears nor installs a route — correctly, since it is a
one-shot request with no tool loop to carry.

**(b) Subagent follow-up user turns already get full blocking compression**,
and have for a long time — same path, same stall, same compressed forward,
logged `followup-compressed` (`src/proxy.ts:1630`). The report's table says so;
its prose ("Subagents and CC side requests never got that second half") is
about routes and reads as broader than it is.

**(c) Subagent tool turns already have transform-only recovery** in the
working tree: a new branch at `src/proxy.ts:1134-1146` sets
`routeMiss = "missing"` for subagent tool turns without consulting the main
slot, and `routeOwning` gains an `isMainRequest &&` conjunct at `:2494` so the
recovery compresses but never installs (`install: "subagent"`,
`src/reqlog.ts:236-240`). The report flags this as "uncommitted as of this
report" — correct, and it means the remaining subagent gap is narrower than
the report's framing suggests.

**Net effect of (a)–(c):** the surviving gap is not "non-main traffic never
touches MemTree." It is precisely this: **non-main traffic has no sticky
prefix, so it pays a blocking server round trip on every large continuation
instead of a free local splice, and gets nothing at all below the gate.** That
is a real and expensive gap, but it is one problem, not four.

**(d) The `count_tokens` premise rests on an unverified claim.** The report
treats "Claude Code sizes its context from count_tokens replies" as
established. In this repo that claim appears only as an unsourced assertion
(`README.md:106`, `src/proxy.ts:1685-1686`). The countervailing evidence is
the incident itself: `plans/2026-08-04_PLAN_tool_turn_route_recovery.md:6-11`
attributes the latched meter to a single `/v1/messages` forward of 976,705
input tokens, and `:485-489` explicitly records that there is **no captured
evidence** a count_tokens preflight preceded it. `ccc` also disables Claude
Code's auto-compaction by default (`README.md:47`), which removes the harm the
count mirror was built to prevent for most users. This does not make the count
mirror worthless — it likely feeds the displayed meter, and both sources
probably contribute — but it does mean count parity should not be sequenced
ahead of payload parity on the strength of an assumption. See §8, Q1.

### 1.3 Missed by the report — five findings that change the design

**(e) The gate is absolute while the harm is relative.** 400KiB ≈ 136k tokens
under this repo's `bytes/3` heuristic. That is **13.7% of a 1M window but
68.3% of a 200k window**. A `claude-haiku-4-5` or a 200k-window model is
already two-thirds of the way to its ceiling before the fuse is willing to
fire. The production log shows all four of `claude-fable-5`, `claude-opus-5`,
`claude-opus-4-8` and `claude-haiku-4-5` taking verbatim `tool` forwards. Any
gate this spec keeps must be a fraction of `modelContextLimit`, which the proxy
already computes (`contextLimitForModel`), with an absolute floor.

**(f) Most of the wasted payload is *below* the gate.** From a 2026-08-08
snapshot of `~/.claude-code-infinite/logs/requests.jsonl` — 4,985 message
records (a live log; figures drift slightly between reads):

| turnType | n | median fwd | p90 | max |
|---|---|---|---|---|
| `tool` (verbatim) | 2,188 | 219 KB | 556 KB | 8.49 MB |
| `tool-memory` (routed) | 2,041 | 478 KB | 915 KB | 5.43 MB |
| `followup-compressed` | 296 | 298 KB | 407 KB | 1.50 MB |
| `followup-degraded` | 20 | 1.27 MB | 8.11 MB | 8.51 MB |
| `first-user` | 274 | 5 KB | 176 KB | 0.19 MB |

- Verbatim `tool` forwards are **43.9% of all message requests** (2,188 /
  4,985).
- **0.67 GB** total forwarded verbatim on `tool` turns; **0.34 GB of it below
  the 400KiB gate**, i.e. invisible to the fuse by design.
- Only **21.4%** of verbatim `tool` turns clear the gate.
- 223.3M input tokens billed across `tool` turns (11.9M of it cache-creation).

The fuse addresses a fifth of the occurrences. A sticky prefix addresses all of
them, because the marginal cost of riding is zero.

Caveat on attribution: these 2,188 rows mix main-thread route misses with
subagent tool turns, and the log cannot separate them — see finding (g). The
total is solid; the split is not, which is exactly why Phase 0 exists.

**(g) The problem is currently unmeasurable, which is the most serious finding.**
`requests.jsonl` records **no agent attribution and no session id** on message
records — `routeRecovery.install === "subagent"` is the only way to spot
subagent traffic in a capture, and it appears only on the rare recovery path.
Worse, `handleCountTokens` passes `undefined` as its `rec` argument
(`src/proxy.ts:2812`), so **the entire count-tokens path writes no log record
at all**. The 2,188 verbatim `tool` turns above cannot be split into main-miss
versus subagent. Under the discipline of `BRITTLENESS-AUDIT-SPEC.md` ("rank
findings by silence, not by count"), this is the highest-ranked item in the
whole report: the failure is silent *and* unattributable. It must be fixed
first and separately, or no later phase can be shown to have worked.

**(h) The 2026-08-04 hole has a surviving twin.** Fix 1 gated the route clear
on `isFollowupUserTurn` (`src/proxy.ts:1016`), which closed the *first-user
shaped* side-request hole. The **followup-shaped** equivalent is still
unclassified: any CC-internal request that replays prior history and carries no
agent header is treated as a genuine main human followup — it bumps the epoch,
clears the route, and then installs a route built from *its own* message list,
because `installMainMemoryRoute` is gated only on
`isMainRequest && routeDecisionCurrent()` (`src/proxy.ts:1443-1455`), never on
hook ownership. `memoryRoutedToolBody` revalidation means this fails closed
rather than grafting, but the effect is still a clear-and-replace that strands
the next real tool turn on a miss. Identity keying does not fix this — it is an
identity misclassification. Content addressing does (§3.4).

**(i) A route entry is 0.4–4 MB of heap, not a pointer.**
`compressedMessages` is exactly one flattened user message
(`flattenToSingleUserMessage`, `src/turns.ts:273-290`) whose content string is
bounded by MemTree's memory budget — up to the "500k whole-request target"
(`src/memtree.ts:51-55`). It is `cloneJson`'d on install and **again on every
ride** (`src/proxy.ts:1897`). Any multi-entry cache must be bounded by *bytes*,
not by entry count, and the per-ride clone should be revisited.

---

## 2. Why identity keying is the wrong axis

The report's desired outcome #1 is "install a route keyed by conversation
identity (main vs `agent_id` vs other stable attribution)". Evaluated against
the code, that design imports a specific set of problems:

1. **The epoch has no per-identity source of truth.** `mainRouteEpoch` is
   bumped by the `UserPromptSubmit` and `Stop` hooks
   (`src/proxy.ts:745`, `:814`) — a separate HTTP endpoint that carries no
   conversation body, only `agent_id === undefined` to mean "main". There is no
   per-agent "new prompt" event and nothing at all for side requests attributed
   only by `x-claude-code-parent-agent-id`. A per-identity epoch would have to
   be *invented*, not ported.
2. **The decision-generation mutex becomes a per-key leak risk.**
   `mainRouteDecisionsLive` is bounded solely by being `.clear()`ed on each
   epoch bump. Per-key sets with no per-key epoch have nothing to bound them,
   and the documented consequence of a leaked reservation is *permanent*
   suppression of that identity's installs (`releaseRouteDecision`,
   `src/proxy.ts:2516-2518`). Left global instead, a subagent's in-flight
   recovery would stale-block main's install via `routeDecisionHolds` — a
   correctness regression.
3. **The sessionless clear has no meaning under a map.**
   `installMainMemoryRoute` clears *the* slot when the installing request has
   no session id (`src/proxy.ts:1841-1844`). With N slots the question "clear
   whose entry?" has no answer.
4. **It doubles down on the brittle input.** `isMainRequest`,
   `hasAgentAttribution`, and `isAwaySummaryUserMessage` are all inferences
   from unpublished Claude Code behavior — exactly the class of dependency
   `BRITTLENESS-AUDIT-SPEC.md` exists to catalogue. Finding (h) shows the
   inference is *already* incomplete today. Making identity load-bearing for a
   larger surface means every future Claude Code change to headers or message
   shapes can silently strand a whole traffic class.

Every one of these is a cost of the *key*, not of the *feature*.

---

## 3. The proposal: a content-addressed prefix cache

### 3.1 The observation that makes it cheap

`memoryRoutedToolBody` already performs a complete content validation before
any rewrite (`src/proxy.ts:1865-1905`):

- `routeValueHash(normalizeRouteSystem(body.system))` vs `originalSystemHash`
- `messages.length > prefixLength`
- `routeMessageHash(messages[i])` vs `originalPrefixHashes[i]`, for every `i`
- `validToolRouteSuffix(suffix)` — non-empty, **no non-tool user message**,
  ≥1 `tool_use`, ≥1 `tool_result`, every `tool_result.tool_use_id` resolving
  within the suffix (`src/proxy.ts:2116-2139`)

Only two of its checks are identity: `sessionId` equality and `routeEpoch`
equality. Both are redundant belt over the content braces. **The validator is
already a content-addressed lookup with a cache of size one.**

So the change is: keep the validator, replace the slot with a bounded
collection, and iterate.

### 3.2 Data structure

```
interface PrefixRoute {
  // --- key material (all content-derived) ---
  originalSystemHash: string;
  originalPrefixHashes: string[];     // one per replaced message
  // --- value ---
  compressedMessages: Message[];      // the flattened memory message
  compressedSystem: unknown;
  hasCompressedSystem: boolean;
  // --- diagnostics only, never a gate ---
  installedBy: { sessionId?: string; agentId?: string; kind: TurnType };
  installedAt: number;
  approxBytes: number;                // for the byte bound
}
```

`state.mainMemoryRoute?: MainMemoryRoute` becomes
`state.routes: PrefixRouteCache` — an insertion-ordered structure bounded by
**total `approxBytes`** (proposed default 48 MB, `CCC_ROUTE_CACHE_BYTES` to
override) with LRU eviction on ride. `legacyMemtreeMigrationComplete`
(`src/proxy.ts:274-282`) is the existing precedent for an insertion-order
bounded per-conversation set; this is the same shape with a byte budget
because entries are megabytes rather than strings (finding (i)).

Entries carry no `sessionId` or `routeEpoch` in their *key*. They record the
installer for logging.

### 3.3 Lookup

```
lookupRoute(cache, body, messages) -> { entry, routedBody } | null
```

For each entry, **longest `prefixHashes.length` first**, run the existing
validation minus the two identity checks. First match wins; on a match, move
the entry to the front (LRU) and return the rewritten body. The candidate set
is small (bounded by the byte budget — on the measured data, well under 20
entries), and each candidate rejects on the first differing hash, so the common
case is a handful of hash comparisons.

Longest-first matters: when a conversation has entries at prefix lengths 40 and
72, a tool turn at length 80 must ride the 72 entry, not the 40 entry.

### 3.4 What this deletes

- **The epoch, from the route-correctness path.** Consider the case the epoch
  exists to prevent: a stale entry ridden by a *new* human turn. The new turn's
  suffix relative to the old entry contains a plain user message, and
  `validToolRouteSuffix` rejects any suffix containing a non-tool user message
  (`src/proxy.ts:2117`). The suffix validator already does the epoch's job,
  content-wise, and does it without consulting identity. `mainRouteEpoch` stays
  — it is still needed for notice lifecycle and recovery-turn classification —
  but it stops guarding the cache.
- **`mainRouteDecisionGeneration`, `mainRouteDecisionsLive`,
  `routeDecisionHolds`, `routeDecisionCurrent`, `releaseRouteDecision`.** These
  exist to arbitrate concurrent writers to one slot. Under content addressing,
  an install is *additive and idempotent by construction*: any value stored
  under key K is a valid compression of prefix K, so a late writer cannot
  produce a wrong entry — only a differently-fresh one. Last write wins, and
  both writes are correct. The entire ralph-review cycle-1/2 class of bugs
  (generation-release, reservation leak, LIFO release) becomes unreachable
  because there is nothing to reserve.
- **`foreignRouteOwner` and eviction-on-reject** (`src/proxy.ts:1114-1123`,
  `:2487-2498`). A reject no longer evicts anything; entries age out by LRU.
  The eviction ping-pong these guard against cannot occur.
- **The `installMainMemoryRoute` sessionless clear** (`:1841-1844`). Nothing is
  ever cleared on install.
- **The `!hasAgentAttribution(req)` gate in `handleCountTokens`** (`:2790`).
- **Finding (h)'s twin hole.** An unclassified followup-shaped side request
  installs an entry keyed by *its own* prefix. It cannot clobber, clear, or
  strand anyone. The misclassification stops mattering.

### 3.5 The isolation argument

The obvious objection: does letting any request ride any entry leak one
conversation's context into another?

No, and the reason is structural. An entry is only served when the requester's
own `system` and every one of its first *n* messages hash-match the entry's.
That means the requester already possesses, and has just transmitted to us,
every byte the entry summarizes. Serving the compressed form returns the
requester's own data in smaller form. There is no path by which content the
requester did not send can be returned to it.

This is strictly stronger than the current `sessionId` check, which is a *label*
match. Two requests can share a session id and be different conversations
(main and a subagent share the header — `src/proxy.ts:451-461`); two requests
cannot share a full content hash chain and be different conversations.

Practical consequence, worth stating plainly so it is not over-sold: subagents
will rarely ride *main's* entries, because their system prompt differs and the
system hash is part of the key. What they get is **their own** entries — a
subagent that compresses once then rides for the rest of its tool loop, which
is exactly the parity the report asks for.

### 3.6 Install sites

Every successful compression installs, from any traffic class:

| Path | Today | After |
|---|---|---|
| Main followup, non-A/B (`src/proxy.ts:1656`) | installs | installs |
| Main followup, A/B memory winner (`:1588`) | installs | installs |
| Subagent followup (`:1630`) | no install | **installs** |
| Away-summary followup | no install | **installs** (harmless; may be ridden by a later matching request) |
| Route-owning main recovery (`:2672`) | installs | installs |
| Subagent recovery (`install: "subagent"`) | no install | **installs** |

Install still happens at protocol-complete (the existing
`forwardRaw(..., onProtocolComplete)` callback), preserving the invariant that
only a response Anthropic actually accepted becomes a route.

---

## 4. Traffic classes after the change

| Class | Payload path | count_tokens | Notices |
|---|---|---|---|
| Main followup | blocking compress → install | rides own entry | unchanged |
| Main tool loop | rides entry; miss → fuse → install | rides entry | none |
| Subagent followup | blocking compress → install | rides entry | none (unchanged) |
| Subagent tool loop | **rides entry** (was: blocking compress or verbatim) | **rides entry** | none |
| Away-summary | blocking compress → install | rides entry | none (unchanged) |
| Unclassified side request, followup-shaped | compress → install its own entry | rides entry | none |
| Unclassified side request, first-user-shaped | verbatim (small; measured p90 180 KB) | n/a | none |

Identity survives in exactly three places, all of them non-correctness:
**notice display** (main thread only — an explicit non-goal of the report to
change), **recovery-turn classification** (`routeRideableByThisRequest`,
`src/proxy.ts:991-993`, a main-thread lifecycle concept), and **the MemTree
health cooldown** (`noteMemtreeHealth`, main-only writes — keep that, per the
uncommitted rationale at `src/proxy.ts:2555-2557`).

---

## 5. Phasing

Each phase ships independently, is separately revertible, and is measurable by
the phase before it.

### Phase 0 — make it measurable and loud (no behavior change)

Prerequisite for everything else; see finding (g). Ship alone.

1. **Attribution on every message record.** Add to `MessagesRecord`:
   `identity: { kind: "main" | "subagent" | "away" | "unclassified", agentId?, sessionId? }`.
2. **A record for `count_tokens`.** New `kind: "count_tokens"` record with
   `requestBytes`, `forwardedBytes`, `routed: boolean`, `identity`. Today this
   path is entirely dark (`src/proxy.ts:2812`).
3. **An oversize-forward alarm.** When a forwarded body is ≥ *R* of
   `modelContextLimit` (proposed R = 15%, `CCC_OVERSIZE_ALARM_PCT`) and the
   turn was neither routed nor compressed, emit
   `oversizeForward: { bytes, approxTokens, pctOfWindow, reason }` and a
   stderr line under `--debug`. After the *k*-th occurrence in one session,
   queue a display-only notice. **This is the detector that would have caught
   2026-08-04 in real time**, and it is worth landing even if nothing else in
   this spec is built.
4. **Backfill the baseline.** Run one real session and publish the split of the
   2,188 verbatim `tool` turns into main-miss vs subagent vs unclassified. That
   number is the denominator every later phase is judged against.

*Kill switch:* none (pure observation). *Risk:* log volume; bound the alarm to
one record per request.

### Phase 1 — the prefix cache

Behind `CCC_ROUTE_CACHE` (default on after canary; `=0` restores the
single-slot main-only behavior, which must remain a working code path for one
release).

1. Introduce `PrefixRouteCache` with the byte bound and LRU.
2. Refactor `memoryRoutedToolBody` into `routeMatches(entry, body, messages)`
   (pure, no identity) + `rewriteWithRoute`. **Do not change the validation
   logic in this step** — it is the load-bearing safety property and it is
   already correct.
3. Replace the single slot; wire the new install sites (§3.6).
4. Delete the generation/reservation machinery and the foreign-owner logic.
5. Keep `mainRouteEpoch` for notices and recovery classification only.

*Risk:* this is the large one. It touches the most-reviewed code in the repo.
Mitigation: the validator is unchanged, the flag restores old behavior, and
Phase 0's alarm makes any regression loud rather than silent.

### Phase 2 — count_tokens parity

Drop the `!hasAgentAttribution` gate; route count_tokens through the same
lookup. Small once Phase 1 lands. Sequence *after* Q1 (§8) is answered, or ship
regardless on the grounds that it is cheap and strictly closer to the truth —
but do not let it be the headline.

### Phase 3 — gate policy

1. Replace `TOOL_RECOMPRESS_MIN_CONVERSATION_BYTES` with a fraction of
   `modelContextLimit` plus an absolute floor (finding (e)). Proposed: ≥ 8% of
   window, floor 128 KiB.
2. Lower it. With universal installs, a miss is rare and its cost amortizes
   across the whole subsequent loop — the economics that justified 400KiB no
   longer hold.
3. Keep the failure cooldown exactly as the uncommitted work leaves it
   (main-only writes, cache-served results prove nothing, shutdown arms
   nothing). Do **not** make it per-identity.

### Phase 4 — optional, only if Phase 0 data justifies it

Relax `validToolRouteSuffix` to permit riding an entry across an intervening
human turn (compressed prefix + verbatim newer turns). This trades memory
*relevance* — the entry's memory was unfolded for an older question — for
payload. It is not needed if Phase 1 achieves high hit rates, and it weakens
the property in §3.4 that makes the epoch removable. Default: don't.

### Precondition — repair the structural interface

`opts.memtree.hasCachedCompress(hash)` (`src/proxy.ts:2256-2257`) is called
unconditionally on a **structurally typed** `MemtreeClient`. Any embedder or
test passing a duck-typed object throws on every blocking compress, and because
the throw precedes `compress()` the symptom is an infinite hang, not an error.
The current suite is green only because the mock was patched
(`test/ab-routing.test.mjs`, +3 lines uncommitted). Before this spec adds
anything to that boundary: use `opts.memtree.hasCachedCompress?.(hash) ?? false`
(`false` = "not cached" = pre-change behavior), and either declare a real
`MemtreeLike` interface or add a startup shape assertion. This is a
`Detect`-family mitigation in `BRITTLENESS-MITIGATION-SPEC.md` terms and the
same silent-failure shape as the incident itself.

---

## 6. Test plan

**Unit — cache mechanics**
- Longest-prefix-first selection with entries at two prefix lengths.
- Byte-bounded eviction; a single oversized entry never wedges the cache.
- LRU promotion on ride.
- Concurrent installs under the same key: both succeed, last wins, neither
  corrupts.

**Unit — validation is unchanged**
- Port every existing `memoryRoutedToolBody` rejection test to
  `routeMatches`: system hash mismatch, shrunk conversation, prefix mismatch,
  bad suffix, empty suffix.
- New: an entry installed by a subagent is **not** ridden by main when the
  system hash differs (the realistic case), and **is** ridden when every hash
  matches (the correct-by-construction case).

**E2E — parity**
- Subagent user turn → subagent tool turn logs a routed turn type and forwards
  a body comparable to main's routed size. (Report acceptance signal #1.)
- Subagent `count_tokens` in that window returns the compressed count.
  (Signal #3.)
- Main session with concurrent subagent traffic keeps riding its own entry;
  a same-session non-main reject does not evict main. (Signal #4.)
- Away-summary mid-loop does not disturb main's entry.
- Regression for finding (h): a followup-shaped side request with no agent
  header does not strand the next main tool turn.

**Replay harness — the product promise as an executable invariant**

The strongest available verification, and worth building once. `captureDir`
already dumps every forwarded body (`ProxyOptions.captureDir`). Capture a real
long session's *inbound* requests, replay them through the proxy against a
stub MemTree, and assert:

1. No forwarded body exceeds *R* of the model window.
2. Every request above the gate either rides an entry or logs a recovery
   attempt — **no silent full forwards**.
3. Total forwarded bytes for the replay drop by ≥ X% versus the pre-change
   proxy on the same capture.

(1) and (2) are the product promise, mechanized. Run it against the 2026-08-04
capture specifically: the replay must show zero oversize forwards.

**Flake discipline:** three consecutive full-suite runs, per existing practice.

---

## 7. Acceptance criteria

Mapped to the report's signals, plus the ones §1.3 adds.

| # | Criterion | Source |
|---|---|---|
| 1 | Subagent tool turn after a compressed subagent turn rides locally and forwards a routed-size body | report #1 |
| 2 | Away-summary and side requests carrying large history are MemTree-reduced | report #2 — **already true**, add a regression test to keep it true |
| 3 | `count_tokens` for any identity reports the compressed size | report #3 |
| 4 | Main rides its own entry under concurrent subagent/side traffic; no cross-eviction | report #4 |
| 5 | Reqlog distinguishes install/ride by identity | report #5 — requires Phase 0 |
| 6 | Verbatim `tool` forwards drop from 2,188/4,985 (43.9%) to a measured target; below-gate verbatim bytes (0.34 GB in the sample) approach zero | finding (f) |
| 7 | The recovery gate is a fraction of the model window; a 200k-window model is protected at the same *relative* point as a 1M one | finding (e) |
| 8 | Any oversize uncompressed forward produces a log record and a debug line — no silent full forwards | finding (g) |
| 9 | Route-cache heap stays under the configured byte bound across a long session | finding (i) |

---

## 8. Open questions

**Q1 — What actually drives Claude Code's context meter?** Undocumented. The
repo asserts count_tokens (`README.md:106`) but the incident evidence points at
`/v1/messages` response `usage` (`plans/2026-08-04_…:6-11`), and the plan's own
author records the count_tokens preflight as unverified (`:485-489`). Resolve
with the statusline-payload observer already specified in
`BRITTLENESS-MITIGATION-SPEC.md:86-99`: drive the CLI against a stub that varies
`usage` and count replies independently and diff `current_usage`. This
determines whether Phase 2 is a headline fix or a tidy-up.

**Q2 — Is a compressed result a pure function of its input prefix?** Content
addressing assumes that two compressions of identical `(system, messages)` are
interchangeable. They need not be *identical* — a warmer index gives a better
answer — but they must both be *valid*. If MemTree's memory unfold can draw on
material outside the submitted messages, the "valid by construction" claim in
§3.4 needs softening (it would still be same-user, same-key, so not a leak —
but last-write-wins would need justifying). Verify against
`polychat/memory/query_context_mem.py`.

**Q3 — Real entry sizes.** §3.2's 48 MB default is derived from the 0.4–4 MB
estimate in finding (i), not measured. Instrument one session before fixing the
default.

**Q4 — Per-ride clone cost.** `cloneJson(route.compressedMessages)` on every
ride (`src/proxy.ts:1897`) transiently doubles a multi-megabyte string. With
more rides after this change, measure whether a copy-on-write or
serialize-once-per-entry representation is warranted.

**Q5 — Should the away-summary install at all?** It installs an entry whose
prefix is the recap request's own history. Harmless, possibly useless. Cheap
to skip; decide with Phase 0 data on whether anything ever rides it.

---

## 9. Non-goals

Inherited from the report and reaffirmed:

- No MemTree server API or indexing changes.
- No hard local payload cap when MemTree is down — degrade to passthrough,
  loudly (Phase 0's alarm), never fail the user's request.
- No change to notice/display attribution: notices stay main-thread only.

Added:

- **No new identity inference.** This spec removes identity from the
  correctness path; it must not introduce a new classifier for quota,
  title-generation, or topic-detection traffic. Those classes are handled by
  being content-addressed like everything else. (No such classifier exists
  today — verified.)
- **No relaxation of `validToolRouteSuffix` in Phases 0–3.** It is load-bearing
  for removing the epoch (§3.4).
- **No per-identity cooldown.** The MemTree health signal stays main-write-only.

---

## 10. Summary of the disagreement with the problem report

Both documents agree on the goal: every history-carrying request uses MemTree,
and no request can brick a session. They differ on one design decision, and it
is the whole decision.

| | Report | This spec |
|---|---|---|
| Cache key | conversation identity (main / `agent_id` / side key) | content (system hash + prefix message hashes) |
| Isolation mechanism | keep identities in separate slots | hashes cannot match across conversations; fail closed |
| Epoch / generation machinery | replicate per key | delete from the correctness path |
| Failure mode of a misclassified request | strands or clobbers its class | installs a harmless entry nobody matches |
| 2026-08-04 root cause | gated against | structurally impossible |
| New brittle Claude Code dependencies | more | fewer |

The report's other two contributions stand unchanged and are adopted here:
compression parity requires a **sticky** prefix rather than a cheaper fuse, and
the `count_tokens` half must be included. The corrections in §1.2 narrow the
work; the findings in §1.3 add a phase in front of it, because a problem this
silent cannot be fixed before it can be seen.
