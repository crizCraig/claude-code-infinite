# Changelog

## [1.0.36](https://github.com/crizCraig/claude-code-infinite/compare/v1.0.35...v1.0.36) (2026-11-13)


### Bug Fixes

* anchor charges images from the parsed body, never with URL images; JPEG walk handles standalone markers (Codex r4 P1s, P2) ([734256e](https://github.com/crizCraig/claude-code-infinite/commit/734256e843a02bf516e256abc17c529e98004fdd))
* anchor only bodies made of blocks it can bound (allowlist); tool references only where already counted (Codex r6 P1s) ([72edeb9](https://github.com/crizCraig/claude-code-infinite/commit/72edeb9af7a93353f3194aceb8d7fe6fd4203347))
* anchor only requests whose fields and tools are all in the body (no mcp_servers, server tools); Claude Code's no-op thinking edit allowed; log anchoredBound (Codex r7 P1) ([29eb65e](https://github.com/crizCraig/claude-code-infinite/commit/29eb65e4dcfc4f68b6f78d070729628a9289ec9d))
* anchor sizes only on a body this one extends, same model (Codex r1 P1s, review r1) ([16c39e5](https://github.com/crizCraig/claude-code-infinite/commit/16c39e561b46e60c895ba0f3c5c89befb1a31c93))
* auto-mode safeguards and data_flow charged in full each turn instead of hashed, so auto-mode lanes anchor; diagnostics stripped only when it is just the previous message id; message fields allowlisted (review r4) ([850d7a0](https://github.com/crizCraig/claude-code-infinite/commit/850d7a031b597c8827804ab08318e4a3d6a8296d))
* image-heavy agent sessions (anchored sizing, heavy-upload and agent-result notices); status line on by default ([128af49](https://github.com/crizCraig/claude-code-infinite/commit/128af49abdd81d443bd20ee6f4168a3818fc2d61))
* image-heavy sessions: anchored size bound, image-aware jumps, heavy-request and agent-result notices; status line on by default ([71419e9](https://github.com/crizCraig/claude-code-infinite/commit/71419e95a6bd55012c380f07544ec0237e38ca27))
* lineage sizes appended messages by canonical bytes; cache_control stripped only where the API puts it; no anchor under server input edits (Codex r2 P1s, review r2) ([fbd2927](https://github.com/crizCraig/claude-code-infinite/commit/fbd29271eb80ad5da7b46db0d55766b6c1049d44))
* no anchored size when the byte scan and the parsed body disagree on images (Codex r3 P1) ([27ee85c](https://github.com/crizCraig/claude-code-infinite/commit/27ee85c4bfbf37b30c844d5c24e7a37e87640d02))
* no anchored size with any externally resolved block (URL/file document, upload); PATH check needs a file (Codex r5 P1, P2) ([f427f00](https://github.com/crizCraig/claude-code-infinite/commit/f427f00724c08bbb55c30962555546a73dcae8c5))
* real Claude Code frames anchor: diagnostics stripped, auto-mode safeguards and the versioned advisor tool allowed (review r3 P1) ([4be3e90](https://github.com/crizCraig/claude-code-infinite/commit/4be3e90fbd4696271be306f209efa77561b3beb7))

## [1.0.35](https://github.com/crizCraig/claude-code-infinite/compare/v1.0.34...v1.0.35) (2026-11-13)


### Features

* refusals say why (indexing ETA, slow upload, rebuilding); MemTree link in the status line ([#66](https://github.com/crizCraig/claude-code-infinite/issues/66)) ([71b937e](https://github.com/crizCraig/claude-code-infinite/commit/71b937ee6378019b3640b1f3dcab4665d945e8ce))

## [1.0.34](https://github.com/crizCraig/claude-code-infinite/compare/v1.0.33...v1.0.34) (2026-11-10)


### Features

* cross-session search shows each hit's summary and matching lines ([a32d420](https://github.com/crizCraig/claude-code-infinite/commit/a32d4202ea2fbfef63ff34c165a104fc8d8595bd))
* MemTree tools say which sessions they cover and why a search came back empty ([#61](https://github.com/crizCraig/claude-code-infinite/issues/61)) ([42b4dc0](https://github.com/crizCraig/claude-code-infinite/commit/42b4dc02619e8ca7b0e15effefa54ccd1db2006b))
* MemTree tools show when each message was written ([#59](https://github.com/crizCraig/claude-code-infinite/issues/59)) ([158daa2](https://github.com/crizCraig/claude-code-infinite/commit/158daa262feb5755a3edb4cf4de50025163f7adf))
* MemTree user_messages and handover tools ([58d3dc0](https://github.com/crizCraig/claude-code-infinite/commit/58d3dc02aa088e489eb2efc5eeb397cb82b13976))
* point headless agents at other sessions' MemTree work ([#62](https://github.com/crizCraig/claude-code-infinite/issues/62)) ([1f6e33f](https://github.com/crizCraig/claude-code-infinite/commit/1f6e33fbb228fd423e00b6c20f2287594aea96ce))
* X-Polychat-Index-Pending: true on a 413 is an index wait; the status says it is an estimate ([7c680d8](https://github.com/crizCraig/claude-code-infinite/commit/7c680d865e242f8176694c6983eab2cf351c71d7))


### Bug Fixes

* a backed-off turn's own late compress that can't connect is a network refusal (Codex r2 P2) ([797d447](https://github.com/crizCraig/claude-code-infinite/commit/797d44707223ce005e483da3d27c5c02c3539077))
* a happy-eyeballs connect failure counts as a failed connect (review r2 P3) ([5ef268f](https://github.com/crizCraig/claude-code-infinite/commit/5ef268f8e4634314f3e14decead46d8deaf4a4aa))
* a lane backing off after MemTree's misfit answer keeps the fit refusal (Codex r1 P2) ([bce5964](https://github.com/crizCraig/claude-code-infinite/commit/bce5964a6d04a19ef82db5afa72182f51448ba15))
* a lane's backoff or cooldown armed while MemTree was unreachable ends once it answers ([b0a5174](https://github.com/crizCraig/claude-code-infinite/commit/b0a5174d2dd07c5e158c9d17f4ceddfa1714f8b5))
* a request queued before its lane's index wait began keeps its bound after a delivery (Codex r5) ([eb78b96](https://github.com/crizCraig/claude-code-infinite/commit/eb78b9600fa4c4e76dc4dd2300aeac48d2d460af))
* a stored JSON string matches only its parse; re-render plus eviction composes (Codex r2) ([873af48](https://github.com/crizCraig/claude-code-infinite/commit/873af48a65a27cee687327cae368575a2495c424))
* a stored prefix survives a model switch that drops ToolSearch's "Tool loaded." note ([d43d482](https://github.com/crizCraig/claude-code-infinite/commit/d43d482de8137a46877e2b7541e79525418e2aaa))
* a turn on an index-waiting lane asks within its own hold; a timed-out re-ask may truncate (Codex r3) ([804ea96](https://github.com/crizCraig/claude-code-infinite/commit/804ea968829dcc92755ee57eb9eba877db32f6d6))
* a turn that arrived during an index wait keeps its bound; its cut-short ask is that wait (Codex r4) ([7feadad](https://github.com/crizCraig/claude-code-infinite/commit/7feadad092f4c193a6f2f5d60dcfb11ba51048e5))
* a vector group ranked over only the newest trees warns even with no hits (Codex r1 P2) ([e99435d](https://github.com/crizCraig/claude-code-infinite/commit/e99435d6c38435c69c84e5d0a296758eccf1d0b2))
* an empty charged search says it was charged; README states the search price (review r1) ([58bf125](https://github.com/crizCraig/claude-code-infinite/commit/58bf12519d619c5f669cd6e5debd7fee94a46497))
* an empty text block with a cache marker is still a rendering choice (review r1 P3) ([2c2bb5b](https://github.com/crizCraig/claude-code-infinite/commit/2c2bb5ba90bdc9dab87a27a68994478147dc01bf))
* drop a stale comment: a vector 422 is no longer charged (review r1) ([43cd922](https://github.com/crizCraig/claude-code-infinite/commit/43cd92257df20575620edb2339ce32de15083b65))
* handover waits for a first pack, page notes, follow-up arguments (review r1) ([3f848db](https://github.com/crizCraig/claude-code-infinite/commit/3f848db293328c9476da07ba45a03d527cb26d55))
* hold a turn while MemTree's index catches up instead of refusing it ([f4e8f78](https://github.com/crizCraig/claude-code-infinite/commit/f4e8f78abab11020cd1b5a01755b38295273c49a))
* index holds end with the lane's wait; a joined indexing 413 may truncate (Codex r2) ([d2803e5](https://github.com/crizCraig/claude-code-infinite/commit/d2803e5dc3b24a39b75f8ca82f3f481a54ab6629))
* index holds stay within their bound and end when MemTree answers otherwise (review r1) ([c754cdf](https://github.com/crizCraig/claude-code-infinite/commit/c754cdf513417a19e5d4f55d63e5c2db8c7ad486))
* keep a persisted prefix across Claude Code re-rendering old messages on resume ([9ffea5e](https://github.com/crizCraig/claude-code-infinite/commit/9ffea5e52c609d07ac29bbe70d7a3c13cc280200))
* MemTree "current" fallback re-checks a served index, and a failed or unusable lookup is unknown (Codex r1 P2s) ([abce372](https://github.com/crizCraig/claude-code-infinite/commit/abce372610fe0875cd2050d650d25ab2d97f986d))
* MemTree "current" falls back to the server's tree for this session when the proxy has none ([8c1435e](https://github.com/crizCraig/claude-code-infinite/commit/8c1435e6d68f86dd52744ad45db9fc8a70d47437))
* MemTree "current" says unknown, not "no tree", for an expired answer it cannot refresh or a server without the sessions endpoint (Codex r2 P2s) ([0fd3b24](https://github.com/crizCraig/claude-code-infinite/commit/0fd3b24313cb9072ae33db7c02b300b1795f7d12))
* MemTree search guidance says a search costs $0.0005 in either mode ([6bef954](https://github.com/crizCraig/claude-code-infinite/commit/6bef954956b4a8a7e0d842dc9069fe5b8d80d7fa))
* only a request's own unanswered compress, and only a failed connect, reads as offline (review r1) ([8ea09f2](https://github.com/crizCraig/claude-code-infinite/commit/8ea09f21981db81967948832111344132176b970))
* portable identity keeps media and parses only lossless JSON inputs (Codex r1) ([c9815e8](https://github.com/crizCraig/claude-code-infinite/commit/c9815e8b08ad1a52222803dce2fbea2bf5145b67))
* portable matching holds each still-string JSON input to its stored string (Codex r3) ([d10f1ca](https://github.com/crizCraig/claude-code-infinite/commit/d10f1caf00ba946dd63282d9d417af6714a1cadd))
* say ccc can't reach MemTree or the internet instead of blaming the context fit ([8d0fdc4](https://github.com/crizCraig/claude-code-infinite/commit/8d0fdc44369288f08298c5be2fced2e708cd66be))
* send an oversized compress with unconfirmed image references instead of not sending it ([e32ee21](https://github.com/crizCraig/claude-code-infinite/commit/e32ee2161a4f7c94e146832ef2761d16acf73e01))
* the memtree tools follow the session their Claude Code process is on ([3f6b22c](https://github.com/crizCraig/claude-code-infinite/commit/3f6b22c554d287256d862f87cda2fb1a78ec6bed))
* two ToolSearch calls in one turn leave two "Tool loaded." notes (review r1 P2) ([7b61bfa](https://github.com/crizCraig/claude-code-infinite/commit/7b61bfa715a028f3930716b8a9fef61f4e84d9b1))

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
