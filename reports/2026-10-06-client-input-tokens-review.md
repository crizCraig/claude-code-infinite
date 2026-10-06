# Client input tokens review

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
