# MemTree savings verification, 2026-11-17

The turn-record rework has 74 passing focused tests with `NO_COLOR` unset and
74 with `NO_COLOR=1`. Both runs include the cross-repository ASGI contract test
using the Polychat conda interpreter and its companion worktree.

The focused command is `node --test test/savings*.test.mjs test/diagnostics.test.mjs test/request-sizing.test.mjs`.
Set `POLYCHAT_CHECKOUT` and `POLYCHAT_PYTHON` to exercise the real HTTP route with
synthetic data and a simulated database transaction.

Regression cases cover immutable turn IDs across processes, resumed sessions,
credential changes during a turn or an acknowledgement, incomplete usage, fast
response mode, tool-loop cache semantics, invalid IDs, partial and unreadable
acknowledgements, restart backoff, key rejection, request sizing, helper progress,
offline refresh and narrow status lines. The multi-process test starts three Node
writers, then replays 90 distinct observations in batches of 50 and 40. The HTTP
test exercises a failed commit and a replay after a lost acknowledgement.

The normal TypeScript build passed. A second build in an empty directory produced
424 distribution files identical in bytes and executable bits.

The separate socket-based proxy monitor/title test stopped at loopback listen with
`EPERM` in this environment. Cross-platform CI is a pre-merge gate.
