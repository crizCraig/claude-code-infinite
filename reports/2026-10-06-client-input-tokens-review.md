# Client input tokens review

## Final result

**ccc is ready to merge.** Final whole-diff review cycle 6 was clean: zero major
and zero minor findings. Across six cycles and the source audit, all 14 findings
(11 major, 3 minor) are fixed; no code findings remain deferred. The request-local
sizing refactor is implemented. The three changes to older refusal-policy tests
were explicitly approved; subsequent existing regression assertions were kept.

Final verification: **543/543 tests passed in each colour mode**, and committed
`dist/` matches a fresh build. Two independent final reviewers each passed the
84-test focused contract suite. The final code fix is `b8a00af`.

The server remains clean, unchanged at `d8bbdf7`, and **ready to merge
independently**. New/old request-field compatibility is verified as described
below. Main's newer unrelated changes are left for merge-time integration.
Live subscription OAuth Count Tokens acceptance is the remaining **pre-publish**
check, not a merge blocker; instructions are below. Nothing was pushed or merged.

## Scope and status

The ccc review covers `main..feat/count-tokens-calibration`, including original
commits `80a8e6e` and `dec90b1`, cycle 1/2 fixes, and the request-local sizing
refactor `650dbf2`. Main has five newer commits concerning the newest-tree link;
their integration is left to merge time as requested.

The server branch `fix/client-input-tokens-budget` remains unchanged at
`d8bbdf770d4975525c86a2a17c2cb64f8b0dfe33`, clean and ready to merge independently.
Nothing was pushed, deployed, published, version-bumped, or migrated.

## Findings fixed before the fresh review

Cycles 1–3 identified 11 findings (8 major, 3 minor). The approved fixes address:

- Learned estimates incorrectly refusing requests that fit the native window.
  Compression remains the first attempt; the compression budget is a trigger,
  not the forwarding ceiling. Every over-budget forward is marked in the log.
- Exact counts being discarded for unusual token/byte ratios or overwritten by
  another request's shared sample. Counts now belong to a particular body.
- Multiple count checks spending separate timeout allowances. They share one
  three-second deadline per request.
- Count payloads omitting supported context/output fields.
- Missing cooldown after rate-limit or authentication rejection.
- Server compression statistics dropping `client_input_tokens`, and missing
  public documentation for that field.
- Missing calibrated hints on non-main, away, and sessionless compression paths.
- Rejecting a large compressed candidate before counting it and losing an
  original that still fits.
- Late counts discovering over-budget input without attempting bounded recovery.
- Contradictory preflight/final measurements: an original counted at 150k fit a
  200k window, but its replacement counted at 210k caused refusal. Main and tool
  regressions were added first and observed failing before the refactor.

The previously deferred refactor is implemented. `RequestSizing` snapshots each
candidate's bytes and calibration, retains its exact result, supplies compression
metadata, and selects among validated candidates before delivery. A fitting
compressed body is preferred; an original that fits remains available. Exact
counts are authoritative. When counting fails or is off, final admission uses
`ceil(body bytes / 4) + reserved output <= native model window`. This remains an
estimate, not a guarantee of the upstream tokenizer's decision.

## Explicitly approved test-policy changes

Only three existing tests changed, with the user's approval:

- `human prefix output reservation: failure`: failed compression still forwards
  a valid byte-fitting prefix rather than refusing on a learned estimate.
- `tool prefix output reservation: failure`: the same fallback applies to tool
  turns.
- `tool prefix output reservation: backoff`: that prefix is also forwarded during
  compression backoff.

Each checks the prefix plus 64k output against the 200k native window. Every other
existing regression was preserved. New converse integration tests require refusal
when all candidates exceed the window, both with exact counts and with counting
disabled. The 469,801-byte subagent regression remains unchanged and passes.

## Verification

- `env -u NO_COLOR npm test`: 536/536 passed.
- `NO_COLOR=1 npm test`: 536/536 passed.
- A further fresh build left staged `dist/` byte-for-byte unchanged; rebuilt
  distribution files are included in `650dbf2`.
- All 30 baseline test files were compared; changes were limited to the approved
  policy blocks and appended regressions. New sizing tests are separate.
- `git diff --check` passed.
- Prior server verification passed module imports, normal and blank
  `WEBUI_SECRET_KEY` startup gates (566 tests), and an amd64 Docker build. The
  review-created image was removed. Server code was not changed by this refactor.

## Cross-version contract and release check

The reviewed server `origin/main` request models ignore the unknown optional
field, so a new ccc against that version does not receive 422 for it. An old ccc
omits the field and keeps existing behavior against the new server. The server
hint can force compression but cannot bypass billing, never-compress policy,
budget caps, or the minimum target. Forced compression with no ready index falls
back through ccc's candidate selection rather than failing an otherwise fitting
turn.

Actual subscription OAuth acceptance by Anthropic Count Tokens is still a
pre-publish check. Launch this checkout's `node dist/cli.js --resume` using the
normal subscription login and send a turn in a large conversation. Inspect that
process's `pid` in `~/.claude-code-infinite/logs/requests.jsonl`:
`countTokens[].statusClass: "success"` confirms a successful count; `"auth"`
means bytes fallback and cooldown. No entry means counting was not exercised.
The entries contain status class and elapsed milliseconds, not bodies or
credentials. Mock API-key/OAuth/header tests establish forwarding and fallback
behavior, not live endpoint acceptance.

## Fresh review cycle 4

Two independent read-only passes reviewed the complete ccc diff after `650dbf2`,
including the original counting, calibration, and cache changes. They found two
major issues, neither fixed without the user's confirmation:

1. **A valid subagent memory route is discarded before candidate selection.**
   `src/proxy.ts:1594–1598` checks the assembled route's byte estimate before
   registering it. A full mock HTTP reproduction first compresses a 1.5 MB
   original counted at 300k into a 900 KB memory body counted at 120k, which fits
   the 200k window. On the next tool turn, the byte check discards that valid
   route. A compression retry returns passthrough; selection only counts the
   original at 300k and returns 503. The fitting memory candidate is never
   counted. Proposed fix: register every history-valid assembled route before
   advisory size checks, preserving it for centralized counting and selection.
   Add a byte-heavy, token-light agent route continuation regression.

2. **Dedup hides a newly available over-budget hint before the server budget is
   known.** `src/memtree.ts:834–837,1145` maps all hints to the same cache bit when
   both explicit target and threshold are absent. Ordinary agent/away followups
   omit those fields before the first budget response (`src/proxy.ts:3017`). In
   a full mock HTTP reproduction, a fresh proxy receives a 240 KB agent followup
   whose count returns malformed JSON; its compression without a hint remains
   in flight. An identical concurrent request counts at 210k, exceeding the
   200k window, but shares that compression promise instead of sending its hint.
   Releasing passthrough gives statuses `[200, 503]`, two count calls, only one
   compression call with no hint, and one forward. The mock server would have
   compressed if it received the second hint. Proposed fix: distinguish differing
   calibrated hints when the effective comparison budget is unknown, while
   retaining the threshold-bit optimization when it is known. Add this fresh-proxy
   concurrency regression.

Other reviewed properties held: count requests preserve API-key/OAuth,
version/beta headers and query parameters; count failures/cooldowns are bounded;
diagnostics exclude bodies and credentials; non-main samples include lane,
agent and model; maps are bounded; request-local snapshots resist concurrent
sample replacement; explicit-threshold cache crossings remain distinct.

**Totals after four cycles:** 13 findings (10 major, 3 minor), 11 fixed
(8 major, 3 minor), two major findings deferred pending approval. One proposed
major refactor was implemented. The three behavior-changing test updates were
explicitly approved. ccc is **not ready to merge** until these two findings are
resolved. The server remains **ready to merge independently** and unchanged.

## Approved cycle 4 fixes and source audit

Both cycle 4 findings were approved and fixed in `96f2b44`, with failing
regressions first. History-valid agent tool routes, agent followup routes, and
away-summary forks now reach request-local sizing before any size-based choice.
Their early byte-only exclusions were removed. Compression planning still
responds to native-window pressure, while structural checks exclude superseded
routes. Unknown comparison budgets now distinguish absent and differing token
hints in compression keys; known budgets retain the threshold-bit optimization.

Five new regressions pass, with every existing test assertion unchanged.
`npm test` passed **541/541** both with `NO_COLOR` unset and with `NO_COLOR=1`.
A further fresh build left committed `dist/` unchanged.

The requested exhaustive source audit is in
[2026-10-06-sizing-path-audit.md](2026-10-06-sizing-path-audit.md). It lists
candidate exclusions, body-size choices, native-window refusal, 400/413/503
paths, and `fitsFallbackBudget` and related helpers, identifying central sizing
delegation or the reason each independent check exists.

The audit confirmed one additional major issue, reported for approval:
`recoverLateCount` (`src/proxy.ts:4620`) drops a structurally valid replacement
before registration if its serialized bytes increase. A 200 KB ride counted at
210k can be replaced by a 250 KB body that would count at 120k and fit the 200k
window, but the guard drops it uncounted. With the original counted at 300k, the
request receives 503. The proposed correction is to register and centrally
measure/select the valid late replacement regardless of byte growth. This issue
is not fixed without approval.

## Fresh review cycle 5

Two independent whole-diff reviews of `main..96f2b44` found **no additional major
or minor issues** beyond the known late-recovery guard. They confirmed both
approved fixes, selected-body usage attribution, route-installation safeguards,
and the source audit's coverage. An additional 82 focused counting, sizing,
cache and proxy tests passed during review; no live API calls were made.

**Current totals after five cycles and the source audit:** 14 findings
(11 major, 3 minor), 13 fixed (10 major, 3 minor), one major awaiting approval.
The request-local refactor is implemented. ccc remains **not ready to merge**
because of the remaining known refusal path. The server remains **ready to merge
independently**, clean and unchanged at `d8bbdf7`. OAuth acceptance remains the
separate pre-publish live check described above.

## Approved final sizing correction

The user approved the audit's remaining finding. Commit `b8a00af` removes the
late-recovery byte-growth guard while preserving structural validation. Every
valid late replacement reaches central counting and selection.

Two new regressions, for main and tool turns, first failed with 503 and then
passed: a 200 KB ride counted at 210k is replaced by a larger 250 KB body counted
at 120k. Tests verify that the replacement itself was counted and forwarded,
the compression hint describes the 210k ride, recovery is bounded to one attempt,
and the over-budget forward is logged. All existing assertions remain unchanged.

Final full-suite runs passed **543/543** with `NO_COLOR` unset and **543/543** with
`NO_COLOR=1`. Committed `dist/` matched a further fresh build. The source audit
now records the corrected late-recovery path.

## Final whole-diff review cycle 6

Two independent fresh reviews of `main..b8a00af` found **zero major and zero minor
issues**. They covered the original counting/calibration changes, all fixes and
the refactor: candidate eligibility/selection, selected-body attribution and route
ownership, failure deadlines/cooldowns, credentials/headers, privacy, sample
isolation, compression hints and dedup. Both confirmed the source audit is
consistent with the remaining checks; both independently passed 84 focused
tests. The five main-only link commits were treated as branch divergence rather
than regressions introduced here.

**Final disposition: ccc ready to merge.** All 14 findings are fixed. Server ready
independently and unchanged. No further code changes are deferred; live OAuth
acceptance remains the pre-publish verification item.
