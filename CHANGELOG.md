# Changelog

## [1.0.33](https://github.com/crizCraig/claude-code-infinite/compare/v1.0.32...v1.0.33) (2026-10-31)


### Bug Fixes

* /memtree-view opens the session's MemTree page and shows one link ([#57](https://github.com/crizCraig/claude-code-infinite/issues/57)) ([aa919ce](https://github.com/crizCraig/claude-code-infinite/commit/aa919ce89e8c8d75a16532328f820b26b43dac0d))
* a prompt never compresses beside the crossing it interrupted ([#58](https://github.com/crizCraig/claude-code-infinite/issues/58)) ([f3c52ad](https://github.com/crizCraig/claude-code-infinite/commit/f3c52adf95f16894296bacdbce2a154f3cc83900))
* concurrent turns share one carried compression; shutdown keeps a held history's media ([#56](https://github.com/crizCraig/claude-code-infinite/issues/56)) ([167b41a](https://github.com/crizCraig/claude-code-infinite/commit/167b41a6e42ce4ad578c777382ce988bf995d7f4))
* large sessions cross the budget without refusals; fewer index uploads ([#54](https://github.com/crizCraig/claude-code-infinite/issues/54)) ([b812b7a](https://github.com/crizCraig/claude-code-infinite/commit/b812b7a8944117fbfef356b06e9aac859ca156ba))

## [1.0.32](https://github.com/crizCraig/claude-code-infinite/compare/v1.0.31...v1.0.32) (2026-10-31)


### Features

* a resumed session is given the current MemTree guidance ([#51](https://github.com/crizCraig/claude-code-infinite/issues/51)) ([bd094ec](https://github.com/crizCraig/claude-code-infinite/commit/bd094ec2ee64e297c4fce643e7bd4325a20e9fcc))
* subagents are told whose memory to search; memtree tools say they are loaded ([#49](https://github.com/crizCraig/claude-code-infinite/issues/49)) ([300aa42](https://github.com/crizCraig/claude-code-infinite/commit/300aa42472d3e750ce63063414dcba76c4d6aba9))


### Bug Fixes

* ask Claude Code whether it is signed in, and hold the sign-in message until it is read ([#48](https://github.com/crizCraig/claude-code-infinite/issues/48)) ([d05e2b5](https://github.com/crizCraig/claude-code-infinite/commit/d05e2b513fa44723257cbb12a3fbfd1460fd1bd1))
* no "ran uncompressed" notice on a refused turn; keep an uncounted prefix as the fallback ([#46](https://github.com/crizCraig/claude-code-infinite/issues/46)) ([56d8003](https://github.com/crizCraig/claude-code-infinite/commit/56d80037ae98f93f515454349b222a63e4739665))
* release 1.0.32 review: no sign-in pause after ccc installs Claude Code, none in CI, no billing message for a rejected env key ([#53](https://github.com/crizCraig/claude-code-infinite/issues/53)) ([e0021e0](https://github.com/crizCraig/claude-code-infinite/commit/e0021e07be358d013efa7e9958ffd64d1e00445a))

## [1.0.31](https://github.com/crizCraig/claude-code-infinite/compare/v1.0.30...v1.0.31) (2026-10-28)


### Bug Fixes

* no email or hook token in the transcript ([#45](https://github.com/crizCraig/claude-code-infinite/issues/45)) ([d5eab2e](https://github.com/crizCraig/claude-code-infinite/commit/d5eab2e8f1862d8362229ba4610c9d21016d769b))
* tell Claude that MemTree handles context, and when MemTree is paused ([#43](https://github.com/crizCraig/claude-code-infinite/issues/43)) ([622a6bc](https://github.com/crizCraig/claude-code-infinite/commit/622a6bcb1cd1518e5be0b099e1eefdb5c8c913db))

## [1.0.30](https://github.com/crizCraig/claude-code-infinite/compare/v1.0.29...v1.0.30) (2026-10-25)


### Features

* compress at ~960k on a prepared prefix, send stored images as references, long-session fixes ([c13464e](https://github.com/crizCraig/claude-code-infinite/commit/c13464e1ef6da6bfa857518a16ba9080c7fe529e))

## [1.0.29](https://github.com/crizCraig/claude-code-infinite/compare/v1.0.28...v1.0.29) (2026-10-23)


### Features

* anonymous npm install ping and first_answer diagnostics event ([#30](https://github.com/crizCraig/claude-code-infinite/issues/30)) ([25f4830](https://github.com/crizCraig/claude-code-infinite/commit/25f48309d2a017bf8a0d5079272e66444ef0a508))
* **memtree:** tools show when the messages were written (with current#N fix, for 1.0.29) ([#24](https://github.com/crizCraig/claude-code-infinite/issues/24)) ([2bdb190](https://github.com/crizCraig/claude-code-infinite/commit/2bdb190be751d9cdb17fade1b9608e87bf42e46b))
* offer to install Claude Code when it's missing; say which rate limit Anthropic hit ([#27](https://github.com/crizCraig/claude-code-infinite/issues/27)) ([db47d86](https://github.com/crizCraig/claude-code-infinite/commit/db47d8620f1969a38f3270d82f723dec0ad484d9))


### Bug Fixes

* credit-balance advice for every sign-in; warn when an API key beats a Pro/Max login ([d890cbc](https://github.com/crizCraig/claude-code-infinite/commit/d890cbc0a07f752063e75fd3dbcfe69e0efd8079))
* credit-balance advice for every sign-in; warn when an API key beats a Pro/Max login ([7a171b9](https://github.com/crizCraig/claude-code-infinite/commit/7a171b903d7ffdc2b24d9e7329022cf027e33fbc))
* fallback budget mirrors the server, every Claude model near its window ([#28](https://github.com/crizCraig/claude-code-infinite/issues/28)) ([7595d8a](https://github.com/crizCraig/claude-code-infinite/commit/7595d8a781635a1c44faa919e16707b31673e2c3))
* keep the credit advice from a subscriber with a paid tier on record; no source hint for an unanswered key ([67c1b24](https://github.com/crizCraig/claude-code-infinite/commit/67c1b2465890e839de0c548c233356407071f4f5))
* no "MemTree degraded" notice on a turn under its compression budget ([#26](https://github.com/crizCraig/claude-code-infinite/issues/26)) ([0c8d71a](https://github.com/crizCraig/claude-code-infinite/commit/0c8d71ab4865c8302ed4299f780634f54961ad1d))
* remember a credit refusal; give its advice before the next launch's first prompt ([#25](https://github.com/crizCraig/claude-code-infinite/issues/25)) ([04dfa79](https://github.com/crizCraig/claude-code-infinite/commit/04dfa797acb11afafd2b3d5c3c95cfd64dbefb30))

## [1.0.28](https://github.com/crizCraig/claude-code-infinite/compare/v1.0.27...v1.0.28) (2026-10-21)


### Features

* name earlier MemTree sessions in this project at session start ([#17](https://github.com/crizCraig/claude-code-infinite/issues/17)) ([0b8dd9b](https://github.com/crizCraig/claude-code-infinite/commit/0b8dd9b78fa7f641d5ff002aebe394895dcbc170))
* one-click short checkout link, clearer payment prompt, plain Claude Code after continue ([#16](https://github.com/crizCraig/claude-code-infinite/issues/16)) ([8863b15](https://github.com/crizCraig/claude-code-infinite/commit/8863b154e3ca9e049743f78493ff161902d05448))


### Bug Fixes

* ccc --version prints ccc's version without asking for a MemTree key ([99854fa](https://github.com/crizCraig/claude-code-infinite/commit/99854fa196536ee89a467b441b5ec872d4bdd24b))
* warn at startup when the MemTree key is invalid (401/403) ([#13](https://github.com/crizCraig/claude-code-infinite/issues/13)) ([f3586ec](https://github.com/crizCraig/claude-code-infinite/commit/f3586ec9e5d1983b2f4fa67e7b9f019d0043a587))

## [1.0.27](https://github.com/crizCraig/claude-code-infinite/compare/v1.0.26...v1.0.27) (2026-10-20)


### Bug Fixes

* a subscription on file always silences the no-plan line; skip Store app aliases ([7e8b7e6](https://github.com/crizCraig/claude-code-infinite/commit/7e8b7e65a6da5094a44539c02774e0ff4c6957bc))
* credit advice only for API-key refusals; no no-plan line for non-session subcommands (review round 3) ([f8a991f](https://github.com/crizCraig/claude-code-infinite/commit/f8a991f811e8af2b238b2dfe3ff5820e8d0ebc1f))
* first-ever MemTree notice no longer links the /report page ([787e7b8](https://github.com/crizCraig/claude-code-infinite/commit/787e7b8030a9356aea072f7add7561a73a7d1762))
* no credit advice for a subscription's refusal; no line on --version/--help (review round 2) ([53f88f6](https://github.com/crizCraig/claude-code-infinite/commit/53f88f67b28f59a781e7d3b9f6aa22679e63862a))
* no-plan line skip list follows Claude Code's subcommands (config is a prompt word now) ([ecf086f](https://github.com/crizCraig/claude-code-infinite/commit/ecf086fc40531721a699954922293bff752ab115))
* warn before the first prompt when Claude Code has no Claude plan; spot the desktop app ([564bdee](https://github.com/crizCraig/claude-code-infinite/commit/564bdeef8f97e6f3e4cfd203cbc9734fe71c47e0))

## [1.0.26](https://github.com/crizCraig/claude-code-infinite/compare/v1.0.25...v1.0.26) (2026-10-18)


### Features

* MemTree tools say when to use them before any compression ([f795c7a](https://github.com/crizCraig/claude-code-infinite/commit/f795c7a1c02f45ae1876359f7ac0b77cbdbda276))


### Bug Fixes

* find and launch Claude Code however it is installed on Windows; safe auto-update there; never over a linked install ([6b0127d](https://github.com/crizCraig/claude-code-infinite/commit/6b0127da7f2cbd0032fd37854b124f6503b45cd2))
* review fixes for Windows updates, pnpm links and sign-in diagnostics ([9d86b5b](https://github.com/crizCraig/claude-code-infinite/commit/9d86b5b32584d5c46f7fcac6b41c7c4f1ade2da0))
* second review round: wait for a Windows update on relaunch, keep print stdout clean ([ca03bc5](https://github.com/crizCraig/claude-code-infinite/commit/ca03bc57d95878f5715f86c55a3ca18c8cbbb117))
* third review round: start the Windows update first in shutdown, find claude.cmd for resume repair ([d11e257](https://github.com/crizCraig/claude-code-infinite/commit/d11e25783b5a1961abf8d96060ab0892d2ee9ce1))

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
