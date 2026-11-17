# MemTree savings validation — 2026-11-17

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
reconstructed. Local persistence currently assumes one proxy process per session UUID.
Desktop service proxies are not wired to this terminal feature. See `docs/savings.md`
and polychat's `docs/memtree_savings.md` / `docs/savings_email.md` for full definitions.
