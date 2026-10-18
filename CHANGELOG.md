# Changelog

## [1.0.25](https://github.com/crizCraig/claude-code-infinite/compare/v1.0.24...v1.0.25) (2026-10-18)


### Bug Fixes

* a paused refusal also withdraws the human turn's near-window line ([787b810](https://github.com/crizCraig/claude-code-infinite/commit/787b810244b3760f802914cfe6836a63d90723d0))
* a paused refusal withdraws an undelivered near-window line ([48761c1](https://github.com/crizCraig/claude-code-infinite/commit/48761c17b9f3e97342ee2f38410cf1aa5bcb8222))
* paused refusal only on a current 402, and suggest native /compact near the window ([e768fe5](https://github.com/crizCraig/claude-code-infinite/commit/e768fe51a2eac21030a1a01e7c04ac9773773e2f))
* say MemTree is paused when a paused session no longer fits the window ([e6f0457](https://github.com/crizCraig/claude-code-infinite/commit/e6f045717a0988675db51416ccb5d15f307d4d76))
* warn once per paused session that /compact still works near the window ([faa4c00](https://github.com/crizCraig/claude-code-infinite/commit/faa4c00834343324f867ab3e5fa71dd329eeb30c))

## [1.0.24](https://github.com/crizCraig/claude-code-infinite/compare/v1.0.23...v1.0.24) (2026-10-18)


### Bug Fixes

* abort hung first-tree probes on Node 20; make their tests deterministic ([4a44352](https://github.com/crizCraig/claude-code-infinite/commit/4a443521bf0f22a855beb07313f99377d255cf49))

## [1.0.23](https://github.com/crizCraig/claude-code-infinite/compare/v1.0.22...v1.0.23) (2026-10-17)


### Features

* ccc link &lt;session-id&gt; prints the session's newest MemTree page URL ([045a99c](https://github.com/crizCraig/claude-code-infinite/commit/045a99c0dd6acf4c5cf048c70e778501fef05d28))
* MemTree tools by default in -p runs, clean stdout, ccc link ([0f84505](https://github.com/crizCraig/claude-code-infinite/commit/0f845051c4073724655a0d6291c8b75734fd3e6a))


### Bug Fixes

* ccc link deadline fires on Node 20; review fixes ([fc4a6cb](https://github.com/crizCraig/claude-code-infinite/commit/fc4a6cbfc58777043662ab0de5511690cd51efe0))
