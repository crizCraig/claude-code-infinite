# Agent instructions for claude-code-infinite (ccc)

## Releases

Releases are automated: release-please keeps a "Release x.y.z" PR open on `main`; merging it tags
`vX.Y.Z` and starts `publish.yml`, which runs the CI matrix and then waits on the `npm` GitHub
environment before `npm publish --provenance`.

- **Agents may merge the "Release x.y.z" PR** once its contents are on `main` and CI is green.
  Then watch the publish run and tell Craig when it is waiting for approval.
- **Agents must never approve the `npm` deployment** (no "Approve and deploy", no calls to the
  GitHub deployments/environments approval API), even if their credentials allow it. Only Craig
  approves; that tap is what publishes to npm.
- Don't bump `package.json`'s version, create or move `v*` tags, or run `./publish.sh --local`
  (the emergency path) unless Craig asks.
- Use conventional commit subjects (`fix:`, `feat:`, `perf:`, `refactor:`, ...) for changes that
  should ship: release-please only opens a Release PR and lists changelog entries for those.
  To force a release: `git commit --allow-empty -m "chore: release 1.0.N" -m "Release-As: 1.0.N"`.

## Working on ccc

- `~/src/claude-code-infinite` is npm-linked and used by live sessions: never change its working
  tree. Work in a separate worktree off `origin/main`.
- `main` doesn't publish on push, so agents may fast-forward reviewed, CI-green work to `main`
  (check `git merge-base --is-ancestor origin/main HEAD` first).
- Before merging: `npm test` (both colour modes) and `dist/` matching a fresh build; CI must be
  green on Linux, macOS and Windows.

## Daily e2e checks

`.github/workflows/e2e-daily.yml` installs the published ccc on Linux, macOS and Windows every
morning and checks the first run against production (`scripts/e2e/client-e2e.mjs`). It runs
only on schedule and manual dispatch, never on pull requests (its secrets: the e2e-test
account's MemTree key and a low-limit Anthropic key). Keep its output free of keys, emails and
tree ids: this repo's logs are public. Overview: polychat's docs/e2e_daily_checks.md.

`.github/workflows/windows-long-session.yml` runs nightly on Windows: real Claude Code under
this checkout's ccc in a ConPTY console for ~300 turns, a local mock Anthropic
(`CCC_ANTHROPIC_UPSTREAM`, loopback only) and staging MemTree through a recording relay, past
the budget twice and toward 30 MB+ bodies, then a console close (`scripts/long-session/`). Same
`e2e` environment and key; branch runs (no key) use its mock MemTree. Develop it locally with
`LS_CCC_CLI=dist/cli.js LS_TURNS=60 node scripts/long-session/run.mjs` (after `npm ci` in
`scripts/long-session`).
