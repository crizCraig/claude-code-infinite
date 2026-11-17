# MemTree savings validation — 2026-11-17

## Round 1 fixes

The savings and diagnostics suites passed all 56 tests in both CI colour modes.
The new regressions were run against the pre-fix implementation. They exercise shared
session writes, untouched and compressed requests, billing-header changes, parallel
tool calls, invalid IDs, durable acknowledgements, incremental accounting, terminal
width, helper progress and fast prices.

- Eight concurrent Node processes each settled 50 turns against one UUID. Across
  eight runs, all 400 turns per run produced distinct consecutive report sequences.
- Both full `npm test` runs produced 955 passes, 710 failures and 11 skips. Every
  failing test also failed on a clean build of the pre-fix commit `84d9eb3`.
  The sandbox denies loopback listeners and restricts process inspection. The live
  monitor/title integration test stopped at the loopback bind.
- All 424 `dist` files matched an independent build into an empty directory,
  including executable bits.

### Local performance measurement

Node 24.2.0 on macOS, one 30 MiB base64 image followed by 20 short message
appends. Each iteration used fresh wire bytes and a freshly parsed request. The
original proxy parse and response forwarding were outside the accounting timer.
Medians were 68.9 ms for the pre-fix duplicate parse plus passthrough accounting,
0.028 ms for the new passthrough accounting, and 0.116 ms for a modified append
with a verified prefix. The required sizing digest took 11.37 ms alone and
11.35 ms with prefix verification. A separate 40-turn run including begin,
locked settlement, the status view and the pending report took 1.03 ms median
and 1.18 ms at p95. These are local timings.

The companion diagnostics endpoint inspected for this round still returns an
opaque `202`. The client keeps its pending snapshot until the endpoint returns
the stored-sequence acknowledgement documented in [the accounting model](savings.md).

## Initial implementation validation

Implementation worktree: `worktrees/claude-code-infinite/memtree-savings-20261117`.
Branch: `feature/memtree-savings-status`, from locally cached `origin/main` at `a6c2582`.
GitHub DNS resolution failed, so the remote tip could not be freshly verified.

- Tests were added before implementation; focused savings/diagnostics suite: **36 pass**.
- Both `env -u NO_COLOR npm test` and `NO_COLOR=1 npm test`: **1656 tests,
  935 pass, 710 fail, 11 skipped** in this restricted environment. The failures are
  701 socket permission failures and nine process-dependent baseline failures.
- The nine non-socket failures reproduce from a separate clean `origin/main`
  worktree: `test/resume-repair.test.mjs` and `test/statusline.test.mjs`, 27 pass / 9 fail.
  Process inspection is denied here. They are not treated as passing gates.
- The new proxy monitor/title integration test is present but cannot run past its
  loopback-listen prerequisite in this sandbox.
- Fresh-build verification: all **412 dist files** matched SHA-256 hashes across builds.
- `git diff --check` passes.
- Linux/macOS/Windows CI and the required fresh-Claude/Codex pre-merge reviews
  remain outstanding; they must not be represented as green.

Logs are local under `/tmp/ccc-savings-{focused-final,test-final-unset,test-final-color1,
proxy-integration,baseline}.log`. No release, merge or publication occurred.

The peer implementation check found and fixed stale billing-generation handling,
shutdown of queued reports, invalid final SSE usage, native-window activity counts,
negative/rounded-zero display, bounded view files, and passthrough calls in session totals.
This check is not the formal fresh-Claude/Codex review required before merge.

Known limits requiring review: the counterfactual includes token-position estimates
and deliberately favorable plain compaction; billing rows may lag six minutes; client
deltas are attributed to server receipt days; historical unobserved turns are not
reconstructed. The original single-writer limitation was addressed in round 1.
Desktop service proxies are not wired to this terminal feature. See `docs/savings.md`
and polychat's `docs/memtree_savings.md` / `docs/savings_email.md` for full definitions.
