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
