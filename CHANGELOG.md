# Changelog

## [1.0.39](https://github.com/crizCraig/claude-code-infinite/compare/v1.0.38...v1.0.39) (2026-11-26)


### Features

* read MemTree from standalone MCP clients ([#92](https://github.com/crizCraig/claude-code-infinite/issues/92)) ([a121096](https://github.com/crizCraig/claude-code-infinite/commit/a12109657193e63eeb2fe05beeea41b13c904add))


### Bug Fixes

* 1.0.39 release-review fixes (Yarn Berry postinstall, status-line link for all users, direct-mode tools, no lookups when links are off) ([df24071](https://github.com/crizCraig/claude-code-infinite/commit/df24071253c75d4be3cae5f8ab32d7dbf2cca049))
* gate display tree-link lookups on effective status-line config ([#96](https://github.com/crizCraig/claude-code-infinite/issues/96)) ([601777f](https://github.com/crizCraig/claude-code-infinite/commit/601777f2e9cb311e73e12159de96fbfa69fceabe))
* gate MemTree browser links and confirm fallback checkout ([#93](https://github.com/crizCraig/claude-code-infinite/issues/93)) ([a32dd52](https://github.com/crizCraig/claude-code-infinite/commit/a32dd5262d3d4f929ccffd94d8e5ffca684e0e74))
* keep writing status-line link files for all interactive setups and omit Stop link only on heartbeat ([#96](https://github.com/crizCraig/claude-code-infinite/issues/96)) ([42a28ea](https://github.com/crizCraig/claude-code-infinite/commit/42a28ea3d2241e8fc57b003e69d60a1419e534ae))
* omit x-memtree-tools when caller registers direct-mode MemTree MCP ([#92](https://github.com/crizCraig/claude-code-infinite/issues/92)) ([993972d](https://github.com/crizCraig/claude-code-infinite/commit/993972d8dcf0c07ff63d3d7b9aeb97de6587b305))
* preserve fitting history when the token count fails ([#97](https://github.com/crizCraig/claude-code-infinite/issues/97)) ([d3f2f87](https://github.com/crizCraig/claude-code-infinite/commit/d3f2f877003246b5f5c9fb443e07c40dddb8ff8f))
* restore v1.0.38 status-link and lookup behavior, keeping Stop heartbeat suppression ([#96](https://github.com/crizCraig/claude-code-infinite/issues/96)) ([f7b44b6](https://github.com/crizCraig/claude-code-infinite/commit/f7b44b669ab6d79984fecfe34010ac27bc6bb8ab))
* run postinstall without ENOEXEC under Yarn Berry while keeping Windows absolute Node ([#91](https://github.com/crizCraig/claude-code-infinite/issues/91)) ([6394f85](https://github.com/crizCraig/claude-code-infinite/commit/6394f852c804158f545304aac721cb58c21caf18))
* search guidance makes hybrid the mode for finding things, text for known exact words ([2f6d5ab](https://github.com/crizCraig/claude-code-infinite/commit/2f6d5abb98721f11cbb900a0ebf9c4142ac8e052))
* skip tree-link lookups when both link displays are off ([#96](https://github.com/crizCraig/claude-code-infinite/issues/96)) ([ae395d6](https://github.com/crizCraig/claude-code-infinite/commit/ae395d65614c0bc03ae4b0cf24288660df9037e9))
* startup banner names Claude Code Infinite first ("∞ Claude Code Infinite · MemTree memory on") ([#89](https://github.com/crizCraig/claude-code-infinite/issues/89)) ([a6c2582](https://github.com/crizCraig/claude-code-infinite/commit/a6c25820bf9184e27af4ec8d2b4e4f04914886d5))
* startup security: no bare-name spawns on Windows; typed-ahead text never becomes an API key ([#91](https://github.com/crizCraig/claude-code-infinite/issues/91)) ([e8cbd37](https://github.com/crizCraig/claude-code-infinite/commit/e8cbd376ee1423deccb84f339d0fa77735b2ba00))
* use argument-aware print detection for interactive link displays ([#96](https://github.com/crizCraig/claude-code-infinite/issues/96)) ([5e94b8f](https://github.com/crizCraig/claude-code-infinite/commit/5e94b8f0ca1495d17bd4d8aa86778d624cbdc033))

## [1.0.38](https://github.com/crizCraig/claude-code-infinite/compare/v1.0.37...v1.0.38) (2026-11-15)


### Features

* CCC_SUBAGENT_PARENT_TREE first-step wording, now what =1 means: the subagent's first call searches the parent's memory ([91c5c3c](https://github.com/crizCraig/claude-code-infinite/commit/91c5c3ca6d20d50f955eca4603c144a64dec7645))
* CCC_SUBAGENT_PARENT_TREE first-step wording, the default for =1 ([926e413](https://github.com/crizCraig/claude-code-infinite/commit/926e4134801063d0a606c312290bbdd363baa47d))
* CCC_SUBAGENT_PARENT_TREE: a subagent's note names its parent session as the MemTree tree, with how to read it (off by default) ([b1fc622](https://github.com/crizCraig/claude-code-infinite/commit/b1fc62259304031d2d9335c516eb8f6f0a2b3ea3))
* CCC_SUBAGENT_PARENT_TREE: subagents get their parent's MemTree as a tree to read (off by default) ([5b84921](https://github.com/crizCraig/claude-code-infinite/commit/5b8492160c58474c4c938ff99fb126dc358c11dd))
* hybrid MemTree search is the default; guidance says to try other wordings before concluding something was never said ([fe3870e](https://github.com/crizCraig/claude-code-infinite/commit/fe3870e6d702d04ec385d673c162fbd4644af728))
* hybrid MemTree search is the default; guidance: try other wordings before concluding something was never said ([4c955fb](https://github.com/crizCraig/claude-code-infinite/commit/4c955fb3a4d4df9041d04297cf8adf2b8257ca88))
* opt-in hybrid MemTree search (CCC_MEMTREE_HYBRID_SEARCH=1) ([7cfe529](https://github.com/crizCraig/claude-code-infinite/commit/7cfe529ae517e8533ceea6dca3365f4b9166d245))
* opt-in hybrid MemTree search (CCC_MEMTREE_HYBRID_SEARCH=1): lists mode hybrid and makes it the search default; hybrid pages say where each ranking placed a hit ([24d3084](https://github.com/crizCraig/claude-code-infinite/commit/24d30844a8b4fed749666bc1e592df2d0152e7cb))
* opt-in subagent lane budget and compress on a cold cache ([c2fa282](https://github.com/crizCraig/claude-code-infinite/commit/c2fa282cf53fdbd05383eb002989a4ba80f44a45))
* opt-in subagent lane budget and compress on a cold cache (benchmark switches, default off) ([2c36fa5](https://github.com/crizCraig/claude-code-infinite/commit/2c36fa5fad3bdefa65ecf531ecf532020e62d29c))


### Bug Fixes

* a compress call also retires a carried index waiting behind an upload; an aborted one retires nothing (review r4) ([66db5fb](https://github.com/crizCraig/claude-code-infinite/commit/66db5fba278d4e28e1c33f78718ec03e405e5906))
* a compress call retires the held-back history it carries when it is sent, not when it succeeds (Codex r3 P1) ([ba540ce](https://github.com/crizCraig/claude-code-infinite/commit/ba540ce37fe8f083588ae9c5ecdff1bddbc058de))
* a compress call retires the held-back history it carries; the stable link sticks once known (review r1) ([30cf272](https://github.com/crizCraig/claude-code-infinite/commit/30cf272822e56802e91d5d0f8262a5b86a4ac257))
* a fragment's exact count no longer replaces the conversation's size sample (review r1) ([da448d2](https://github.com/crizCraig/claude-code-infinite/commit/da448d2cef480c457c42cac8ad2ee403e60828e2))
* a held history given back when its compress call never reaches the server; a final index retires it too (Codex r4) ([55384ce](https://github.com/crizCraig/claude-code-infinite/commit/55384ce06a6569ca763aab84393f9f2d2a262204))
* a held-back history never goes while a newer compress call is in flight; one that repeats the last upload is dropped (review r2) ([8ff6c7f](https://github.com/crizCraig/claude-code-infinite/commit/8ff6c7f6e39f8ec376acd12fad28113f8e8cad11))
* a known stable link is rewritten if its file was pruned; only this session's /m/sessions link is taken (review r9) ([7c46f01](https://github.com/crizCraig/claude-code-infinite/commit/7c46f01b6666655e8d3394e88801f50f15e47c67))
* a persisted stable link gives way once this server answers; a remembered link needs no lookup (review r10) ([701d436](https://github.com/crizCraig/claude-code-infinite/commit/701d4362442e47d83fde78f4da1c4ed6f3585480))
* a resumed session keeps its persisted prefix across Claude Code 2.1.325's media placeholders and restored media ([0ea4a92](https://github.com/crizCraig/claude-code-infinite/commit/0ea4a92479d9f16db1daaf2201ba0cc27c112041))
* a resumed session keeps the stable link its status-line file holds; no refresh once it is known (review r8) ([79f78ce](https://github.com/crizCraig/claude-code-infinite/commit/79f78ce8ca84aefb83a31eebef3127a016725c68))
* an answer with no tree also updates the status line; another server's persisted link is removed when nothing replaces it (Codex r11) ([1a77601](https://github.com/crizCraig/claude-code-infinite/commit/1a77601a258d4d0128a3d7848afe780d1a705810))
* an away recap warms main only when its fork body is what went out; coldCache documented as the arrival sample (Codex r2 P3, review r3 P3) ([1c1aa68](https://github.com/crizCraig/claude-code-infinite/commit/1c1aa68dc229efe7fb6c15982f3924de88b82b26))
* away recap warms main only on its prefix ride; a cold claim needs the lane idle since arrival; threshold-honoring test mock, agent followup threshold test (review r2 P3s, Codex r1 P3) ([84f9683](https://github.com/crizCraig/claude-code-infinite/commit/84f9683ef16d43b6a980498cececbc4eee18eb0a))
* cold-cache clock stamped at the upstream send, once per gap; away recap warms main; no degraded notice, prepared adoption and agent followup threshold (review r1) ([fc36a0c](https://github.com/crizCraig/claude-code-infinite/commit/fc36a0c057bf4213ee4ddde12ce2616cb6cf7895))
* empty hybrid page points at the notes after it (review r3 P3) ([0292d79](https://github.com/crizCraig/claude-code-infinite/commit/0292d79578e2c2e994bcd3474ab64637629bf450))
* first-step uses the parent's findings only where they cover the task (facts only for an independent check) and says memory shows files and logs as they were (review r1) ([1e15caa](https://github.com/crizCraig/claude-code-infinite/commit/1e15caafd2e10ffe22732505106a2f5d4a0efc13))
* hybrid search opt-in review fixes: refuse an explicit hybrid unless opted in, describe hybrid as the default in the tool and instructions, fall back to text when the server has it off, keep text for a bare cursor, show each search's failures and partial rankings (review r1, Codex r1) ([fb9e70d](https://github.com/crizCraig/claude-code-infinite/commit/fb9e70d91f135278388a3473e05d72957aefc964))
* hybrid with a cursor continues the text page a refused hybrid fell back to; opt-out wording names no hybrid (review r1: Codex P2, Opus P3s) ([d99c4db](https://github.com/crizCraig/claude-code-infinite/commit/d99c4dbec3953e6dabda3e9e620831da73f85e0e))
* no size sample from a thread continue; ccc's own 400 backstop for message threads ([5a9bc11](https://github.com/crizCraig/claude-code-infinite/commit/5a9bc11a18f4aa62add9347055842991329bce7d))
* no size sample from a thread continue; ccc's own 400 backstop for message threads ([3ad5bf2](https://github.com/crizCraig/claude-code-infinite/commit/3ad5bf2bd0cd3b85cae000b9d702e81eb9a7c9e5))
* one high-water mark replaces restoring held histories (review r5) ([d71b3ad](https://github.com/crizCraig/claude-code-infinite/commit/d71b3adc6ac593c8f750d0258ea00a36d6712cae))
* put-back media matches only slot by slot, never added or moved media; only Claude Code's exact placeholder texts (Codex r1 P1/P2/P2, review r1) ([9badad8](https://github.com/crizCraig/claude-code-infinite/commit/9badad8045afb7a409112b257b55ca81a0534d50))
* resume guidance carries the hybrid wording when hybrid is on; an empty hybrid page says a search failed only when one did; hybrid default notes the un-indexed tail is text-only (review r2, Codex r2) ([33511cb](https://github.com/crizCraig/claude-code-infinite/commit/33511cb997c7923cdf089c2519aa15842daf02ee))
* resumed sessions keep their persisted prefix across Claude Code 2.1.325 media placeholders and put-back media ([5296c0c](https://github.com/crizCraig/claude-code-infinite/commit/5296c0c76fb8111441256883738f1e69c3ded987))
* slot entries come from the blocks the slot hash is built from; one digest per media block for both identities; no put-back on the last covered message (review r2 P3, Codex r2 P2/P2/P3) ([920a6ce](https://github.com/crizCraig/claude-code-infinite/commit/920a6ce1dbb87affff0a1834ec3097bb5e3ee482))
* status line links the session's stable MemTree page; held-back indexes reach the page within 3 min ([26748a7](https://github.com/crizCraig/claude-code-infinite/commit/26748a714c5c6be515611501c78d2d360dd83557))
* the carried mark follows the newest sent history on any branch (Opus r6 P2) ([89b99ef](https://github.com/crizCraig/claude-code-infinite/commit/89b99efde9102c2dc89ec52cb25b898668c41a2e))
* the exact-media guard is on the last covered message that is not ambient system (Codex r3 P2) ([f9fd49a](https://github.com/crizCraig/claude-code-infinite/commit/f9fd49aca769568d1532269acbe8a2b6c642a27c))
* the parent-tree note names only tools the session has, says hybrid only when search defaults to it, and never steers a subagent away from current files (review r1) ([d634f1e](https://github.com/crizCraig/claude-code-infinite/commit/d634f1eb82d6cd8322f491a2bf879ebb50dad3cf))
* the stable session link is kept before the session's first tree (Codex r2 P2) ([78fc8b5](https://github.com/crizCraig/claude-code-infinite/commit/78fc8b5cd87d2e3b3379a23f2e6ef6927970d6ed))
* the status line links the session's stable MemTree page; held-back indexes go within 3 minutes ([efc674b](https://github.com/crizCraig/claude-code-infinite/commit/efc674b19253cccffbc7588eb7c3d9b301cf5e5c))


### Reverts

* take the index hold limit out of this change (needs a design decision) ([e980a02](https://github.com/crizCraig/claude-code-infinite/commit/e980a0241a2575fdb21100ba7b963dbd7d9b6ada))

## [1.0.37](https://github.com/crizCraig/claude-code-infinite/compare/v1.0.36...v1.0.37) (2026-11-14)


### Features

* delta uploads (message refs) behind CCC_MEMTREE_DELTA=1, default off ([f8972e2](https://github.com/crizCraig/claude-code-infinite/commit/f8972e2bae50edeb244ff926ff895715bac4b67b))
* opt-in ccc desktop mode (Claude desktop app, macOS) ([b231968](https://github.com/crizCraig/claude-code-infinite/commit/b231968b9b0d5214dabb71d8a15456dfc37c03a7))
* opt-in ccc desktop mode: MemTree for the Claude desktop app's Code tab (macOS) ([0d625d5](https://github.com/crizCraig/claude-code-infinite/commit/0d625d593b7f3d6c1fa39b7164b1439e05599e9a))
* opt-in HTTPS-proxy mode for Remote Control in ccc sessions ([4b781e5](https://github.com/crizCraig/claude-code-infinite/commit/4b781e5027f77e76529753853e000738839829cc))
* opt-in HTTPS-proxy mode so Remote Control works in ccc sessions (macOS, Linux) ([7956da0](https://github.com/crizCraig/claude-code-infinite/commit/7956da066453f957d6229f0fa1fb55f5fe886cf9))


### Bug Fixes

* a fragment is never a follow-up, so it reserves no route decision (Codex r2 P2, review r2) ([88c7973](https://github.com/crizCraig/claude-code-infinite/commit/88c7973129969df82b96b92ac21d075644b0db9b))
* a message shorter than its ref is sent as it is (a delta never outgrows the full body); disabled conversations bounded (Codex r3) ([4bca948](https://github.com/crizCraig/claude-code-infinite/commit/4bca94886e3357023438b6d59c5c7592f19e3296))
* a thread continuation still cancels the pending final index; fragments skip compress, route and recovery; old releases' no-tool main turns stay the conversation (review r1, Codex r1 P2s) ([85d35bf](https://github.com/crizCraig/claude-code-infinite/commit/85d35bfa57b26994a1a12d12c1614d678fa3417f))
* acked messages' images are not decoded again, LRU for refused hashes, cache-mark positions skip keys JSON drops, message-refs declared only while active, image-409 resend logged (review r3) ([2275d60](https://github.com/crizCraig/claude-code-infinite/commit/2275d60ea36cd705a656d0f4df433121a7192924))
* an image-ref 409 on a delta body resends the turn's ordinary body; all-missing check uses a set (Codex r2) ([19cf051](https://github.com/crizCraig/claude-code-infinite/commit/19cf051ebef8366f1a0b3cf4c47a174d823360ba))
* deltas stay under the server's 32 MiB rebuild cap, size-cap 400s resend without disabling refs, the feature header is fixed with the body across transport retries (review r4, Codex r4) ([8ec0086](https://github.com/crizCraig/claude-code-infinite/commit/8ec0086a59c475b193203413259816299d3f7d32))
* desktop MCP follows the session after /clear, certificate expiry flagged, Bash keeps the user's CA and env file, rotate-ca without launchd says to restart (review r1) ([f827d8a](https://github.com/crizCraig/claude-code-infinite/commit/f827d8af230be941493e7962fa20b6b7b3e4fbb8))
* desktop upstream held to loopback, sessions whose project enables the sandbox refused (Codex r1 P1s); NO_PROXY covering Anthropic refused at setup, the user's CAs for the service's own TLS (Codex r1 P2s) ([14cae11](https://github.com/crizCraig/claude-code-infinite/commit/14cae116e200670d8f14061e210ef675d5c650a4))
* each Desktop session's settings check also reads setup's CLAUDE_CONFIG_DIR, which the agent gets too (Codex r2 P1) ([08307da](https://github.com/crizCraig/claude-code-infinite/commit/08307da31a46f2ed512e26e1829214f35a1d9450))
* message refs per conversation (session + opening), 409-named hashes never acked again, no acks from a trimmed body or an exit index's early answer, server-side image cap resends in full, one deadline across resends, ambiguous openings stay inline (review r1, Codex r1) ([aea130b](https://github.com/crizCraig/claude-code-infinite/commit/aea130bd6943d9f062a75ff1d5d7de39403e234c))
* refused message refs always resend (even after the lane went off), only partial 409s ban hashes, refs and cache marks within the server's limits, no refs on the final index (review r2) ([44eb3b8](https://github.com/crizCraig/claude-code-infinite/commit/44eb3b87a67e00bcd228c3dd47511cdbac1027ec))
* settings with a BOM or CLAUDE_ENV_FILE keep base-URL mode (Codex r1 P1, P2); no warning in base-URL fallback, none for one blocked prompt, no tunnels once draining (review r1 P3) ([f63b228](https://github.com/crizCraig/claude-code-infinite/commit/f63b2284edcbfcc9c6a231ab7890db7932eaf869))
* side requests and message-thread continuations no longer become the session's MemTree conversation ([b506bac](https://github.com/crizCraig/claude-code-infinite/commit/b506bacb1f67d126806fc2c684467f6ec57c6314))
* side requests and message-thread continuations no longer become the session's MemTree conversation ([fdd9dbf](https://github.com/crizCraig/claude-code-infinite/commit/fdd9dbf2d3136d36f96b2ac15a2f51b3f7e16d1a))
* threads-off comment says what the switch does and that settings env wins; README caveats; test pins the parent env and CCC_AUTO_COMPACT (review r1, Codex r1 P3s) ([4cfdcea](https://github.com/crizCraig/claude-code-infinite/commit/4cfdcea06d750a2aee796b0f0bee9731e1f40841))
* turn Claude Code's message threads off so every request carries the whole conversation ([3d02298](https://github.com/crizCraig/claude-code-infinite/commit/3d02298405fa7d31a1ea1274e018c238aab667b9))
* turn Claude Code's message threads off so every request carries the whole conversation ([24f03e6](https://github.com/crizCraig/claude-code-infinite/commit/24f03e62fff03d7624f1957d9c266028ddb08ec2))

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
