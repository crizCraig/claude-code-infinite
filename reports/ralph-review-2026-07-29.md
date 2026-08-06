Å# Ralph Review — 2026-07-29

**Status: complete — 10 cycles, 33 issues found (5 major, 28 minor), all 33 fixed. Final cycle verdict: no major issues remain; suite 221/221, typecheck clean.**

- **Baseline:** `96ea5eb` (user's work snapshotted as `e6e5223` — "Extract claude-env module; expand proxy retry/relay handling and MemTree budget logic")
- **Scope:** ~2,000 changed lines across `src/proxy.ts`, `src/memtree.ts`, `src/turns.ts`, `src/cli.ts`, `src/cli-args.ts`, `src/reqlog.ts`, `src/claude-env.ts`, `src/index.ts`, tests, and README
- **Process:** each cycle, a fresh reviewer subagent reads the full cumulative diff and the surrounding code, then independent fix subagents repair each issue with regression tests (red/green verified where noted). Every cycle ends with a `[ralph-review]` commit.
- **Suite:** 189 tests at baseline → 221 passing after cycle 10 (32 regression tests added).

| Cycle | Commit | Issues found | Majors |
|---|---|---|---|
| 1 | `79c002f` | 5 minor | 0 |
| 2 | `f3ac1d6` | 5 minor | 0 |
| 3 | `92f4faf` | 1 major, 3 minor | 1 |
| 4 | `7301542` | 1 major, 4 minor | 1 |
| 5 | `8df61c9` | 3 minor | 0 |
| 6 | `ddbce17` | 1 major, 1 minor | 1 |
| 7 | `2a1d104` | 1 major, 1 minor | 1 |
| 8 | `bae0957` | 1 major, 1 minor | 1 |
| 9 | `8856079` | 3 minor | 0 |
| 10 | `3eb14bc` | 2 minor | 0 |

All 33 issues found across the 10 cycles were fixed. Majors are marked **[MAJOR]**; everything else was filed as minor.

---

## Cycle 1 — `79c002f`

### 1.1 Recovery-prompt detection matched raw substrings, including system-reminder text
`isRecoveryPromptTurn` promoted a tool_result wrapper to a compressible "recovery" user turn whenever the concatenated text of the last message contained the armed prompt as a substring — *including* `<system-reminder>` text, which is stripped everywhere else. **Failure scenario:** the user queues a short prompt mid-turn (e.g. "continue"); an intermediate tool wrapper whose reminder text coincidentally contains that word gets misclassified as the recovery turn, consumes the one-shot arm, pays a blocking compress, and flattens an in-progress tool loop. When the *real* merged-prompt wrapper arrives, the arm is gone and the turn degrades to the sticky full-history passthrough this feature exists to prevent. **Fix:** new `messageCarriesPromptText` helper examines each top-level text block individually, strips system-reminder spans (reusing `stripSystemReminderText`), and matches only when the armed prompt is an entire block or sits at a block's start/end. Applied at both correlation sites (`isRecoveryPromptTurn`, `hookOwnedMainFollowup`). Regression test: a decoy wrapper whose reminder contains the prompt must not consume the arm.

### 1.2 Legacy-migration flag set on weak evidence
`legacyMemtreeMigrationComplete` (then a process-global boolean) was set when both compress legs returned warm-up no-ops — normal for any fresh conversation — and could also be set by an empty-vs-empty tie decided by tail size, which the code's own comment says must never end the migration. **Failure scenario:** one fresh conversation permanently disables the legacy probe for a pre-upgrade session `/resume`d later in the same `ccc` run, so its deep legacy index is never reused. **Fix:** the flag is only set when the canonical result was actually compressed *and* usable; legacy no-ops no longer count as evidence. (Superseded by deeper fixes in cycles 3–4.)

### 1.3 Legacy probe doubled blocking latency serially
The probe `await`ed a second full `compress()` (its own ~15s budget, re-uploading the whole conversation) *after* the canonical one, so during active migration every user turn paid up to ~30s of serial blocking budget. **Fix:** both compress legs now start together and are awaited via `Promise.all` — one budget of wall clock. A barrier-mock regression test deadlocks (1s timeout) under any serial implementation.

### 1.4 Stale billing header replayed when the header-count invariant broke
In `currentRouteSystem`, if the current request or stored compressed system carried ≠ 1 recognizable `x-anthropic-billing-header` block (e.g. Claude Code reorders fields so the matcher misses), the code silently fell back to the *first* request's system — replaying its stale `cch`/`cc_prev_req` attribution on every tool call of the turn. The identity hash fails **closed** on the same sensitivity; this path failed **open**. **Fix:** new `withoutRouteBillingHeaders` strips every recognizable billing-header block when the invariant breaks — missing attribution instead of wrong attribution. E2E test covers the mismatch case.

### 1.5 Suite red without `NO_COLOR` (pre-existing)
One test asserted the plain MemTree notice text, but the delivered `systemMessage` arrives ANSI-green-wrapped when `terminalSupportsColor()` is true (piped stdio under `node --test`). Failed identically at the baseline commit — pre-existing, not introduced by the diff. **Fix:** the assertion strips ANSI escapes before matching; verified passing with and without `NO_COLOR`.

---

## Cycle 2 — `f3ac1d6`

### 2.1 Migration flag ended by a conversation that never had a legacy index
Cycle 1's stricter conditions still let branch 1 (`!shouldProbeLegacyMemtree(...)`) set the process-global flag on *any* fresh conversation whose canonical answer was compressed, usable, and small-tailed — no legacy evidence required, recreating the `/resume` hazard from 1.2 by another door. **Fix:** both migration-ending branches now require a compressed legacy answer that actually lost a real contest. (Further hardened in cycles 3–4.)

### 2.2 Good legacy result thrown away when the canonical leg failed
The decision block was gated on `canonicalResult && ...`: if the canonical compress returned null (server error/timeout) while the concurrent legacy probe held a good compression, the turn degraded to passthrough despite a usable result in hand. Concrete trigger: `normalizeMessagesForMemtree` drops thinking-only assistant messages, which can leave adjacent user messages only in the canonical payload — if the server rejects that shape, only the canonical leg fails, every turn. **Fix:** a failed canonical leg now falls back to a compressed *and usable* legacy result (`usedLegacyFallback = true`) instead of degrading; unusable legacy results still degrade loudly.

### 2.3 Retried recovery turn lost its classification
`state.mainPromptArmed = false` executed before forwarding — before delivery was known to succeed. **Failure scenario:** recovery wrapper is classified and compressed; upstream answers 529; Claude Code auto-retries the identical body; the arm is gone and no route was installed, so the retry is classified as a plain tool turn and the whole remaining tool loop forwards full history. **Fix:** new `ProxyState.mainPromptDelivered` window — opened by the `UserPromptSubmit` hook, closed by the Stop hook and by an epoch-guarded `markMainPromptDelivered()` on all five successful-delivery paths. Recovery classification now accepts `armed || !delivered`, so a 5xx retry reclassifies; the arm itself stays consumed, so notices can't double-fire. Red/green-verified regression test (529 → identical retry → still compressed).

### 2.4 Dead `actuallyCompressed` guards
An early return established `actuallyCompressed && historyCheck.usable` for all subsequent code, leaving five later guards provably dead and actively misleading (a reader would conclude no-op results can reach the delivery `.then`). **Fix:** removed the dead conditions; invariant documented at the early return.

### 2.5 `ccc --ab-speculative` was a silent no-op
After the A/B default flip (enabled only when `CCC_AB_ROUTING=1`), the `--ab-speculative`/`--ab-buffered` flags were still parsed and stripped but never took effect. **Fix:** an explicit delivery flag now opts in to A/B routing by itself (new `resolveAbRouting` in `cli-args.ts`, unit-tested); `CCC_AB_ROUTING=0` still wins but prints a stderr warning instead of silently ignoring the flag. README updated.

---

## Cycle 3 — `92f4faf`

### 3.1 [MAJOR] The probe manufactured its own migration evidence
Cycle 2's "real contest" rule had a hole the reviewer proved out: the probe leg itself *warms a legacy index server-side* for any conversation containing thinking blocks — including brand-new post-upgrade sessions. **Failure scenario:** fresh conversation, turn 1 warms both legs; by turn 2–3 the legacy leg compresses (from its own turn-1 probe write), loses the contest to the equally fresh canonical index, and the process-global flag is set. The user then `/resume`s a deep pre-upgrade session in the same process: probe disabled forever, cold canonical index no-ops, full history forwarded — and on an over-window session that request 400s at Anthropic ("prompt is too long") with the identical retry hitting the cached no-op, wedging the turn. **Fix:** `legacyMemtreeMigrationComplete` became a bounded per-session `Set` (evict-oldest at 64; eviction only re-opens probing, the safe direction), keyed by `x-claude-code-session-id` with a first-message-hash fallback. A fresh conversation can now only end the migration *for itself*. Also: a server omitting `raw_prompt_tokens` no longer counts as caught-up evidence.

### 3.2 Installed route survived a failed delivery and defeated the retry
A route installed at protocol-complete (`message_stop` accepted) survived when the client socket died before flush. The identical-body retry then saw an installed route, so `isRecoveryPromptTurn` vetoed; the tool path computed an empty route suffix, cleared the route, and forwarded full history as a plain tool turn — the exact degradation 2.3 targeted, via a different door. **Fix (notable):** the reviewer's suggested delivery-time route clearing would have *broken the deliberate fast-tool case* — "client consumed message_stop, ran a fast local tool, closed the SSE early" and "socket died before flush" are indistinguishable at delivery time (`delivered=false`, protocol complete, client aborted). The fix agent proved the two cases separate deterministically at the *next request* (a fast tool call extends the route's prefix; an identical-body retry cannot) and instead changed the classification-time veto to "route exists **and this request can ride it**" (`messages.length > originalPrefixHashes.length`). Fast-tool behavior preserved (all three pre-existing route-activation tests pass); retry reclassifies. Red/green-verified on both the legacy and A/B non-compare paths.

### 3.3 Thinking signatures counted as "retained conversation"
`contentChars` JSON-stringified blocks without a `.text` field, so `thinking`/`redacted_thinking` blocks counted their opaque base64 `signature`/`data` toward `retainedChars`. One or two signature blocks (~1–2k chars each) could satisfy the 2,000-char empty-memory floor, letting an effectively amnesiac legacy result pass as usable — exactly the case the check exists to catch — and biasing the legacy-vs-canonical comparison. **Fix:** thinking blocks count only `block.thinking.length`; `redacted_thinking` counts 0 — matching what flatten actually puts in front of the model. Applied symmetrically to both sides of the measurement.

### 3.4 Canonical timeouts hidden by a legacy rescue
`rec.compress.timedOut` was computed on the post-swap result, so a canonical timeout rescued by the legacy fallback logged `ok:true, timedOut:false` — losing the timeout signal for exactly the turns where the canonical leg burned its full budget. **Fix:** `timedOut` computed from the canonical leg's outcome. (Refined in cycle 4.)

---

## Cycle 4 — `7301542`

### 4.1 [MAJOR] Migration key conflated main and subagent conversations
`legacyMigrationKey` used only `x-claude-code-session-id` — but subagent requests carry the *same* session id as the main thread (which is why `hasAgentAttribution` exists). **Failure scenario:** a deep pre-upgrade session is `/resume`d; the user runs a multi-turn subagent in the same session; within a few turns the subagent's shallow probe-warmed legacy index loses a genuine contest → the *session* key is marked complete → the main conversation's probe is disabled forever, its deep legacy index never contested — the cycle-3 contamination relocated from "any conversation in the process" to "any conversation in the session." **Fix:** the key folds in agent attribution (`session:X:agent:id|main`, with a content-key fallback for the parent-id-only edge). Regression test: a subagent's lost contest must not stop the main conversation's probe.

### 4.2 Migration ended with no tail measurement
`shouldProbeLegacyMemtree` was fixed in cycle 3 to keep probing when `raw_prompt_tokens` is absent, but the lost-contest branch still marked completion when `isBetterLegacyMemtreeResult` returned false merely because *both tails were unmeasured*. **Fix:** the lost-contest branch additionally requires measured tails on both legs.

### 4.3 `timedOut` attributed the legacy probe's wall time to the canonical leg
`compressMs` wrapped the whole `Promise.all`, so a fast canonical failure (200ms 5xx) beside a budget-burning legacy probe logged `timedOut: true` for a leg that demonstrably didn't time out. **Fix:** the canonical promise records its own duration; `timedOut` uses that. `compress.ms` remains documented as overall wall time.

### 4.4 `redacted_thinking` payloads shipped as prompt text
Cycle 3's accounting assumed flatten drops redacted blocks — it didn't: `extractTextForFlatten` fell through to `serializePart`, JSON-stringifying the whole block, base64 `data` included, into the flattened user message sent to Anthropic. **Fix:** flatten now skips `redacted_thinking` blocks entirely (empty-extraction handling verified safe — no dangling `[ASSISTANT]` headers), making flatten match the accounting and keeping opaque bytes out of the compressed prompt.

### 4.5 Headerless migration keys collided across conversations with identical openers
The fallback key hashed only `messages[0]`, so two conversations opening with the same text ("hi") shared a key and one's won contest ended the other's probe. **Fix:** `conversationContentKey` hashes `messages[0]` plus `messages[1]` when present — stable per conversation (blocking compression only runs on followup turns, so the first assistant reply exists and is fixed), distinct across identical openers. A deliberately rejected alternative (message-count bucket) would have changed every turn and broken key stability; the residual same-first-two-messages collision is documented as accepted.

---

## Cycle 5 — `8df61c9`

### 5.1 Empty-memory gate sank good compressions of paste-heavy turns
`checkCompressedHistory` gated on `retainedChars − currentTurn(as sent) ≥ 2000`. If the server shrank the current turn itself — e.g. a 100k pasted log summarized to 5k — the subtraction went deeply negative and a result carrying ample real memory scored as empty: turn recorded `followup-empty-memory`, full history forwarded, route cleared — compression silently disabled on exactly the turns where it matters most. **Fix:** the gate now subtracts only the *verbatim echo* of the sent turn found in the result (new `contentTextPieces` + `echoedCurrentTurnChars`, measuring the same text the char counter measures). A rewritten turn leaves no verbatim echo and counts as retained context; a genuine echo-with-nothing-prior still scores ~0 and stays unusable. Strictly more permissive than before, so every previously-usable case stays usable.

### 5.2 `compress.ok` doc overstated its meaning
The doc claimed "a usable compressed result was obtained," but `ok` is `result !== null`, set *before* the no-op/empty-memory checks — `followup-noop` and `followup-empty-memory` turns log `ok:true` while the proxy discards the result. Anyone filtering the request log on `compress.ok` would over-count successes. **Fix:** doc reworded to match the code, pointing readers at `turnType`/`history.usable`.

### 5.3 Per-leg `timedOut` semantics untested
No test asserted the cycle-3/4 timing semantics, so a refactor back to wall-time measurement would have passed the suite. **Fix:** three deterministic tests (fast canonical 5xx + slow rescue → `false`; canonical budget-burn + fast rescue → `true`; budget-burning legacy + fast canonical failure → `false` with a self-check that wall time crossed the budget). Mutation-verified: each of the two plausible wrong implementations fails exactly one specific test.

---

## Cycle 6 — `ddbce17`

### 6.1 [MAJOR] Double verbatim echo passed the empty-memory gate
Empirically confirmed by the reviewer: a result whose memory block embedded the current turn verbatim (framed) *and* whose tail replayed it was credited 2N of echo but clamped to N by a `Math.min(echoed, turnText.length)` cap, so `retained − echoed ≈ N + framing ≥ 2000` — silent amnesia forwarded as a compressed body (5,280-char turn: double-echo → usable, single-echo → correctly unusable). Realistic shape: on an identical-body retry the first attempt already indexed the current turn, so recency-biased memory returning the just-indexed turn plus the tail echo is precisely the degenerate output the gate exists to catch. **Fix:** cap removed; embedded pieces credited once per *containing result piece*. Every verbatim copy is by definition not prior conversation, so all residual error is over-subtraction, which fails safe.

### 6.2 Sub-32-char fragments counted as echo
The substring branch had no length floor, so small result pieces that happened to be substrings of the current turn (quoted-back prior messages, repeated pastes) were scored as echo even when they were genuine memory — fail-safe, but able to disable compression on overlap-heavy turns, and uncapped once 6.1 removed the clamp. **Fix:** `ECHO_MIN_PIECE_CHARS = 32` floor on both sides of the containment check, safely below every piece size the existing tests rely on.

---

## Cycle 7 — `2a1d104`

### 7.1 [MAJOR] Two echo copies inside one text block defeated the empty-memory gate
Cycle 6's "once per containing result piece" crediting used boolean `piece.includes(turnPiece)` — so a memory blob containing the current turn *twice in a single block* (`"Relevant memory:\n<turn>\n---\n<turn>"`, realistic when two overlapping index nodes both return the just-indexed turn) was charged for only one copy, and the second scored as retained prior conversation. Empirically confirmed against the built code: ~5.3k-char turn, `retainedChars` 10,586, echo 5,282 → `usable: true` with zero prior conversation. The same mis-score could also wrongly end a legacy migration or win a legacy contest. **Fix:** new `echoedCharsInText` counts every non-overlapping occurrence of each turn piece via an `indexOf` loop; over-counting on overlap remains fail-safe.

### 7.2 An echo fragmented into sub-floor pieces bypassed subtraction entirely
Both sides of the containment check were length-gated by the cycle-6 32-char floor, so a turn echoed back as many 31-char text blocks scored zero echo and passed the gate (demonstrated: 171 × 31-char blocks → `usable: true`). Low realism, cheap hardening. **Fix:** `contentTextRuns` coalesces *adjacent* joinable text pieces (plain strings, `text` blocks) within one message into runs before the containment check — fragmented echoes concatenate back into the verbatim turn and are subtracted in full — while thinking/JSON pieces stand alone and prose-separated quoted fragments in genuine memory stay uncounted. Each run scores `max(coalescedRunEcho, sumOfPerPieceEchoes)` so a truncated echo adjacent to unrelated prose is still caught.

---

## Cycle 8 — `bae0957`

### 8.1 [MAJOR] A framed *and* truncated echo escaped the accounting entirely
The cycle-7 matcher recognized two shapes: whole-text containment (catches truncation) and whole-piece embedding (catches framing) — but a copy that was **both** ("The user said:\n" + the turn cut off at 40k chars, zero prior conversation) matched neither and scored zero echo → `usable: true`. Empirically confirmed; realistic because memory blobs are already framed and a budget cutoff mid-echo produces exactly the truncation. **Fix:** the matcher was rebuilt as `echoedCharsInRunText` — one masking probe-and-extend scan per coalesced run (32-char head *and* tail probes per turn piece, greedy bidirectional extension, non-overlapping interval masking), catching whole, truncated, front-truncated, framed, framed+truncated, fragmented, and multiple distinct copies in a single pass.

### 8.2 The `max(coalesced, perPiece)` rule dropped a distinct second copy
A single run carrying a fragmented reassembling echo *plus* a separate truncated-echo block scored `max(5.4k, 3.0k)` instead of `8.4k`, letting the truncated copy count as retained history. **Fix:** subsumed by the unified masking scan — each copy is found and charged once; the per-piece/coalesced/max structure is gone. One shape is deliberately conceded and documented: a copy truncated at *both* ends and framed (neither probe present).

---

## Cycle 9 — `8856079`

### 9.1 Substring turn pieces could open an uncharged gap inside a bigger echo
When an early turn piece was a verbatim substring of a later, larger piece, the small piece's charge became an *interior mask* inside the large piece's copy; head/tail extensions capped at the interior masks, leaving the region between them uncharged (demonstrated flip: charged 2,200 of a 3,000-char echo → gate passed). Realism modest (a multi-block turn whose early blocks quote a later block). **Fix:** pieces are scanned longest-first (a substring can never out-length its superset), and extensions now *skip through* an interior mask when the piece content still matches across it at the aligned offset — with a skip-only-after-charging-progress bound so the skip can't reintroduce quadratic scanning.

### 9.2 Interval helpers were quadratic on probe-dense shapes
The charged-span helpers linearly scanned a growing list per probe hit — O(runText × pieces × spans), measured 56ms at 100k chars and 451ms at 300k (quadratic), synchronous on the response path, recomputed up to 4× per turn during migration. **Fix:** the span list is kept sorted by start with binary-search insertion; overlap checks are O(log n) and extension caps read adjacent spans directly. Measured after: ~8ms at 100k, ~14.5ms at 900k. The complexity docstring now states the true bound.

### 9.3 README and `claude-env.ts` contradicted each other about the resume threshold
One said the suppressed 100k-token recommendation was "Resume from summary", the other said it was `/compact`. Verified against the Claude Code sessions documentation: the threshold gates the **"Resume from summary" dialog option** (which internally runs `/compact`) — the README was right. **Fix:** the `claude-env.ts` comment now matches.

---

## Cycle 10 — `3eb14bc` (final)

The final reviewer stress-tested the round-9 echo scan with a 20,000-case differential fuzz against a mask-free coverage oracle plus targeted adversarial constructions: zero invariant violations, zero over-charges, performance linear. Two minor findings, both fixed directly:

### 10.1 Echo-scan docstring named only one of its two conceded shapes
Adversarial construction showed a second under-charge shape beyond the documented both-ends-truncated+framed concession: a copy whose head probe lands inside territory an earlier piece's extension already charged, while its tail is truncated out of the run. The reviewer judged both shapes unrealistic (they require remixed, mask-geometry-aligned echoes never observed from real servers — realistic whole/truncated/framed/fragmented echoes are all charged fully, confirmed empirically). **Fix:** the docstring now names both concessions and why the trade is accepted.

### 10.2 Dead `changed` flag in `normalizeMessagesForMemtree`
`changed` and `removedReasoning` were set only together and always equal. **Fix:** removed `changed`.

**Final verdict from the cycle-10 reviewer:** no major issues remain; accumulated-fix interactions (delivery window × route rideability × epochs; echo gate × legacy contest × migration marking; billing-header stripping × route hashing) are internally consistent; no debug remnants, `test.only`/`.skip`, or dead code from the fix rounds.

---

## Verified sound (checked, not changed)

- **`claudeChildEnv`** (`src/claude-env.ts`): doesn't mutate the parent env; the first-party base-URL override is safe because the CLI hardcodes `api.anthropic.com` as upstream.
- **Protocol-complete route activation ordering:** `SseNoticeRewriter.push` parses complete frames synchronously, the notify listener registers after `pipe()`, epoch guards discard stale activations — verified in cycles 1, 3, 4, and 5.
- **`handleCountTokens`** route rewrite matches tool-loop routing, so counted context equals sent context.
- **`resolveAbRouting` / flag plumbing, README accuracy** — re-verified in cycle 4.

## Open notes (not fixed — flagged for a human)

- **`NATIVE_ONE_MILLION_MODELS`** (`src/turns.ts`): I verified the list against the current Anthropic model docs — every listed model (opus-4-7/4-8, opus/sonnet/fable/mythos-5, mythos-preview) is documented at 1M. The docs also show **Opus 4.6 and Sonnet 4.6 at 1M**, which the code treats as beta-header-gated (200k without the `context-1m-*` header) — the tests encode that deliberately, and the docs table doesn't distinguish native-vs-beta-gated for the 4.6 generation, so I left it as the author wrote it. Worth a one-time check against the Models API (`max_input_tokens`) if 4.6-generation users report short budgets.
- **Near-verbatim echoes** (server trims whitespace / re-renders a tool_result block) escape echo subtraction entirely; the docstring declares rewritten-echo leakage a deliberate trade, but the trade is somewhat wider than the comment implies.

---

## Final summary

- **Cycles:** 10
- **Issues found:** 33 (5 major, 28 minor)
- **Issues fixed:** 33 (5 major, 28 minor)
- **Remaining issues:** 0 open defects. Two documented design concessions in the echo scan (judged unrealistic by adversarial analysis) and the 4.6-generation native-1M ambiguity above are flagged for human awareness, not left as defects.
- **Commits:** snapshot `e6e5223`, fixes `79c002f` `f3ac1d6` `92f4faf` `7301542` `8df61c9` `ddbce17` `2a1d104` `bae0957` `8856079` `3eb14bc`
- **Suite:** 221/221 passing, `tsc --noEmit` clean.
