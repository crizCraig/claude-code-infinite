# Message threads: ccc and MemTree with Anthropic's server-held conversations

Status: plan (2026-11-14). Nothing here has shipped. The stop-gap that turns threads off is
being built separately (worktree `proxy-threads-off`; coordination in
`~/src/agent-bus/threads/ccc-message-threads/notes.md`). This plan starts from that stop-gap.

Craig's ask: "Anthropic is moving to a more efficient way to transfer things. We need to get
ahead of it."

## Recommendation

1. **Ship the stop-gap now, in every mode, with a backstop that ccc controls.** Set
   `CLAUDE_CODE_TETHER_LIVE=0` in base-URL mode too, not only in HTTPS-proxy and desktop mode.
   With the variable set to 1, a probe showed base-URL mode sends threads, so today only
   Anthropic's rollout flag keeps them away. Back the variable up with a proxy-side switch:
   ccc answers a request that carries `thread` with a 400 `thread_unsupported_request`
   error, and Claude Code then goes stateless for the rest of the session (probe below).
2. **Then let threads through, behind `CCC_MESSAGE_THREADS=1`, with ccc keeping the
   conversation itself.** ccc keeps a per-lane *thread ledger*: the last full (`create`)
   request, plus each streamed reply, plus each continue's new messages. MemTree indexing and
   the final index read the ledger, so the MemTree server needs no change (delta uploads keep
   the upload small). When the conversation reaches the budget, ccc does not build a request
   itself. It answers that continue with a fake 404 `thread_not_found`. Claude Code then
   resends the whole conversation as a `create` at once, and the compression path we have
   today handles it. The compressed `create` becomes the server's new thread, and later
   continues add to it. This is the compaction recipe Anthropic documents.
3. **Make two small server changes, then one optional one.** `/v1/context_memory` refuses
   continue bodies, so a forwarded tail can't become an orphan tree. The partner docs say
   when to create a thread and when to continue one. Later, and only if refs lists get large,
   add a MemTree "append" mode that mirrors Anthropic's continue.

Why it is worth doing: threads are a TTFT and bandwidth gain for long agent loops, which is
where MemTree users live. Pricing and rate limits are unchanged. Claude Code already uses
threads for first-party users, and its off switch is an undocumented environment variable.
If the variable is renamed, or the rollout reaches base-URL mode, every ccc mode loses
mid-loop compression and indexing at the same time. We should be able to run with threads
on before that happens.

## 1. How threads work

### Public contract

Sources: [Message threads docs][docs] and the [Nov 2, 2026 release note][rn].

- Beta header `message-threads-2026-08-12`, sent on every request of a thread. There is a
  body field `thread`.
- **Create.** This is a normal full request (`system`, `tools`, all `messages`) plus
  `"thread": {"type": "create"}`. The API stores the conversation and Claude's reply under the
  response `id` (`msg_...`). A thread has no separate thread id: a thread is a chain of
  response ids.
- **Continue.** `"thread": {"type": "continue", "previous_message_id": "<last response id>"}`
  with only the messages after that response. Fields come in three groups:
  - Create-only: `system` and `tools`. The docs say sending either one on a continue gives a 400.
  - Fixed: `model`, `tool_choice`, `thinking`, `mcp_servers`, `context_management`,
    `output_config`, top-level `cache_control`, and the set of `anthropic-beta` values. A
    change gives 400 `thread_fingerprint_mismatch`, and the message names the fields.
  - Free: `max_tokens`, `stream`, `metadata`, and so on.
  The API does not check the new messages against the ones it already holds.
- **Append-only, linear.** Each response id can be continued once (400
  `thread_already_continued`), and only after `message_stop` (400 `thread_continue_in_flight`
  while it runs). To edit, branch or compact, you start a new thread with a `create`. The docs
  say this outright under "Compact a conversation": "start a new thread from the summary ...
  in a new create request with `system` and `tools`." **So a client may start a thread from a
  modified or compressed history, and the API never compares it with any earlier thread.**
- **Lifetime.** A thread expires 5 minutes after its last request, and each stored response
  restarts the clock. It is deleted no more than 1 hour after its last use. It is held only in
  memory and is not ZDR- or HIPAA-eligible. There is no API to list, read or delete a thread.
- **When a continue fails** the answer is 404 `thread_not_found`, and the client replays the
  full conversation as a new `create`. The causes include: expiry; a turn that was served but
  not stored (for example, a tool call cut off by `max_tokens`); a reply written by a fallback
  model; a different key, workspace or user; and a first image added to a thread that had
  none. After a refusal, the client must not continue the thread. The docs say the client is
  the source of truth for the conversation: "Keep your own copy of every message".
- **Caching and billing.** "Threads do not change pricing or rate limits." "A thread does
  not cache your prompt for you": breakpoints work as they do without a thread. There are at
  most 4 `cache_control` breakpoints per request, and `system`/`tools` breakpoints from the
  create count again on every continue. One too many gives 400 `thread_unsupported_request`.
  Errors are returned before the model runs and cost no tokens.
- **Not supported:** batches, `count_tokens` with `thread`, compaction/compaction-on-demand,
  context editing other than `clear_thinking_20251015` with `keep: "all"`, and HIPAA or
  inference-hook orgs. Thinking blocks: if a new create changes `system` or `tools`, drop the
  `thinking` blocks on Opus/Sonnet/Haiku 5.5, Fable/Mythos 5.1 and 5.2.

### What Claude Code 2.1.325 does

Source: strings from the native binary `~/.local/share/claude/versions/2.1.325`. The internal
name is "tether", and the log lines start with `[tether]`. The probe below confirms the parts
marked *(probed)*.

- **Who gets threads.** `CLAUDE_CODE_TETHER_LIVE`, a tri-state environment variable, wins.
  Otherwise threads need the first-party provider, experimental betas on (that is, not
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` and not HIPAA), a non-ZDR org, an internal check
  this plan could not resolve, and the GrowthBook flag `tengu_curious_tower`. Also excluded:
  models in `tengu_curious_tower_stateless_models`, `CLAUDE_CODE_SIMULATE_PROXY_USAGE`, and
  teleport/relay states. The main lane and subagents each get their own thread (keyed by agent
  id). Side queries and hook agents never get one.
- **Create or continue.** Claude Code keeps hashes of the fixed config for each agent (model,
  system, tools, betas, latched headers, thinking, tool_choice, effort, extra body) and one
  hash per message. It sends a continue only when the new history *strictly appends* to what it
  last sent and nothing in that config changed. Otherwise it sends a `create`, with a reason:
  `first_request`, `no_continue_pointer`, `config_changed`, `history_reshaped` (/compact,
  snip, tool-result clearing, abort strip), or `history_rewound` (rewind, /clear). Other
  reasons force a create: a missing or incomplete anchor, transcript drift, a presumed expiry,
  or citations the continue would drop. These make the turn stateless (no `thread`): server
  tool use or `search_result` citations in history, tools added or removed mid-conversation
  (behind `tengu_lucid_anchor`), ephemeral messages, and a model already held stateless.
- **Expiry estimate.** Claude Code tracks idle time per thread on the client. The TTL comes from
  `tengu_jaunty_charm.ttl_seconds` (default 300, clamped to 300-3600 s). A separate
  `cc_closed_turn_ttl_seconds` applies when the anchor reply did not end in a tool call. So
  Claude Code may expect a longer server TTL than the public 5 minutes for turns waiting on a
  human. Past the TTL it sends a `create` ("thread idle for N s ... sending a create").
- **Inherited fields.** On a continue, behind `tengu_quiet_heron`, Claude Code leaves out
  `tools` and sends only the billing-header block of `system` *(probed: 219 chars, 1 block,
  against 4 blocks / 29 KB on the create)*. That differs from the docs, which say any `system`
  on a continue is a 400. Either the server accepts that block for Claude Code, or it isn't the
  billing header: **unknown U2**. If a continue is refused for a fingerprint mismatch, Claude
  Code sends full fields for the rest of the session.
- **Error handling.** A 404 whose `error.details.error_code` (or message) is
  `thread_not_found` makes Claude Code replay the turn as a `create`. So do
  `thread_fingerprint_mismatch` (fields restored), `thread_already_continued`, and any other
  thread 400 on a continue. *(probed)*: a 400 `thread_unsupported_request` resends the turn
  without `thread` and marks that agent and model stateless for the session. An unrecognised
  400 on a request that carried the header is resent once without the header. A "thinking
  dropped for prefix mismatch" report from the server (`input_transformations`, behind
  `tengu_wondrous_acorn`) can make Claude Code re-create the thread, or hold it stateless.

### Probe (2026-11-14, real `claude -p` 2.1.325 against a mock upstream)

The mock is `mock.mjs` in this session's scratchpad (see the coordination notes). It uses
base-URL mode, an API key and `CLAUDE_CODE_TETHER_LIVE=1`, and runs a four-step Bash tool loop.

| Run | Requests seen |
|---|---|
| plain | `create` (1 msg, 12 tools, 4-block system); then 4 x `continue` (1 msg: the tool result, no `tools`, 1-block system), each anchored on the previous mock id |
| 404 on the first continue | `create`; `continue` -> 404; **`create` with all 3 messages, `tools` and full `system`**; then continues from the new id |
| 400 `thread_unsupported_request` on the create | `create` -> 400; the same turn without `thread`; every later request without `thread` (1, 3, 5, 7, 9 messages) |

What the probe settles: (a) base-URL mode is not protected by its mode, only by the rollout
flag. (b) A proxy can ask Claude Code for the full conversation whenever it wants, at the cost
of one local round trip. (c) A proxy can turn threads off for a session without the
environment variable.

## 2. Options for ccc

### Today (main b506bac)

PR #75 classifies `thread: {type: "continue"}` as `thread-continue`: a *fragment*. Fragments
are forwarded unchanged, with no compression, route, recovery or MemTree upload, and they
never replace the noted conversation. A `create` is a full request and goes through the normal
path, so it may be compressed or ride the stable prefix. With threads on, the result is:

- **It works, by accident.** If ccc compressed the create, the server's thread holds the
  compressed history, and Claude Code's continues add to it. That is the same as riding the
  stable prefix.
- **It breaks in three ways.** (1) No budget check ever runs on a continue, so a long tool
  loop, or human turns less than 5 minutes apart, can grow the server's thread past the model
  window. `DISABLE_AUTO_COMPACT` is on under ccc, so Claude Code won't compact for us. (2)
  Nothing after the last create is indexed. (3) The final index sends the last create's
  conversation and misses the rest.

### (a) Rebuild the full conversation for MemTree: the thread ledger

A continue tail does **not** include the reply it continues from: Claude Code never resends
it. Rebuilding therefore needs the replies.

| Source | Exact wire form | Available | Verdict |
|---|---|---|---|
| Stored create + **replies read from the response stream** + tails | yes (thinking signatures, tool ids) | for every request ccc forwards | **primary** |
| Claude Code's session transcript (`~/.claude/projects/.../<session>.jsonl`; ccc already reads it for the final reply and message times) | no (local form: reminders, splits by `message.id`, cleared tool results) | written after the reply, so it races | cross-check, and the final-index fallback |
| Force a create (fake 404) whenever the full body is needed | yes | any request time, but never at Stop | for budget crossings, and to repair the ledger |

The ledger, one per (session, lane or agent id), capped like Claude Code's own 128 threads:
`{ original: Message[]` (the create's messages as Claude Code sent them, before compression),
`system, tools, fixed-field hash, tipId, tipComplete, lastUsage }`.

- On a **create**: reset `original` to the body's messages. Keep `system` and `tools`.
- On each **response**: accumulate the stream (`message_start` gives the id;
  `content_block_start/delta/stop` build the blocks, including `signature_delta` and
  `input_json_delta`; `message_delta` gives `stop_reason` and usage) on a tee of the bytes
  ccc already forwards. Decompress as ccc does for usage today. Set `tipId` only when the
  reply finished (`message_stop`, `stop_reason` not null), was not a refusal, and has no
  `fallback_message` in `usage.iterations`, because those replies are never stored. Then
  append the reply.
- On a **continue**: if `previous_message_id === tipId`, append the tail. The full
  conversation is then `original` plus replies plus tails. That is exactly what Claude Code
  would have sent without threads, so `noteMainConversation`, `indexInBackground`,
  `count_tokens` sizing and the final index all take it unchanged. If the ids don't match
  (ccc restarted, a reply ccc couldn't parse, a lane ccc never saw): answer the fake 404, and
  the create that follows rebuilds the ledger.
- **Loop guard:** at most one fake 404 per anchor. If two creates in a row still leave the
  ledger unusable, answer `thread_unsupported_request`, and that lane is stateless for the
  session.

No new uploads: with delta uploads on (`CCC_MEMTREE_DELTA=1`, tracker step 4), each index call
already sends refs for acked messages, plus the new messages inline.

### (b) Compression with threads

When a continue would reach the budget, there are two ways to do it.

- **(b1, recommended) Fake 404, then today's path.** Estimate the size of the server's thread:
  the last reply's `input_tokens + cache_read_input_tokens + cache_creation_input_tokens +
  output_tokens`, plus an estimate of the tail. This is the "reported size" anchor ccc already
  keeps for each lane. If that is under the budget, forward the continue unchanged. At the
  budget, answer the fake 404. Claude Code sends the full `create`, and the tool-turn or edge
  compaction we have today compresses it. The compressed create starts the new thread (keeping
  `thread: {type: "create"}` and the headers as sent), and Claude Code's continues add to it.
  ccc builds no request body itself, keeps no copy of `system`/`tools`, and can't get a fixed
  field wrong.
- **(b2) ccc turns the continue into a create itself**, from the ledger's `original`, replies
  and tail, its stored `system`/`tools` and fixed fields, and `thread: create`. This saves the
  extra round trip and the localhost upload, but it duplicates Claude Code's request
  building. Do it only if harness timing shows b1's extra round trip matters. It won't, next
  to a blocking MemTree compress call.

**Cache and cost.** Threads change neither pricing nor caching. A compressed create misses
the cache for the new compressed prefix and writes it, exactly as today's compaction does.
After that, continues read the cache through Claude Code's own breakpoints. A replay create
of *unchanged* bytes (after an expiry, or a ledger-repair 404) should read the cache warmed by
the thread's turns, because the cache is keyed by content, not by thread. Verify this in the
harness (H4). If Claude Code itself sends a create later (expiry, a config change), ccc rides
the stable prefix byte for byte, as it does today, so the cache still hits. What we lose on a
forced create is only that turn's TTFT and bandwidth gain. So threads on with forced creates
always send at most what threads off sends today, and they avoid the full upload on every
other turn.

**Rules ccc must keep on threaded requests:**

1. Never change a fixed field between a create and its continues: model, betas,
   `context_management`, top-level `cache_control`, and so on. ccc forwards headers unchanged
   today. Keep it that way.
2. Add no `cache_control` to `system` or `tools` beyond what Claude Code sent, because those
   breakpoints count again on every continue (limit 4). `capCacheBreakpoints` already caps the
   create. Add a test that asserts the continue's own count.
3. Never send one continue twice. A route-fallback retry, an A/B or speculative send, or a
   recovery resend would hit `thread_already_continued` or `thread_continue_in_flight`. Any
   path that would resend a continue answers the fake 404 instead.
4. Compressed history and thinking blocks: nothing new here. ccc doesn't change
   `system`/`tools`, and the preserved-thinking prefix checks apply to compressed creates
   exactly as they apply to today's compressed requests. Watch for Claude Code's
   drop-recreate logic (`tengu_wondrous_acorn`) reacting to a compressed create (U4).

### (c) MemTree server changes

- **None are needed for (a)+(b1).** ccc rebuilds the full conversation and uploads it as it
  does today, with delta refs (`docs/memtree_delta_upload.md` in polychat, tracker steps 0-5
  in `plans/2026-09-26_PLAN_conversation_messages_in_postgres.md`). Turning deltas on in prod
  (tracker step 5: `CONVERSATION_STORE`, then `CONVERSATION_STORE_DELTA`, then a ccc release)
  is the matching win on the MemTree side, and with threads on it matters more.
- **S1 (small, do it).** `/v1/context_memory` answers a body with
  `thread.type == "continue"` with a 400 that says to send the full conversation (or message
  refs). Today the server would take a tail as a whole conversation: a new
  `first_msg_prefix_hash`, an orphan tree, and a "compression" of a fragment. This is the
  PR #75 bug moved to the server, and it can come from any client or partner that forwards
  Claude Code bodies. A `thread: {type: "create"}` field is harmless, so ignore it.
- **S2 (later, optional): MemTree append mode.** Today a delta upload still lists one ref per
  message (about 70 bytes each, so about 140 KB for a 2,000-message session, capped at 50,000
  refs). An append form, `{"memtree_append": {"after_request": <ack id>}, "messages": [new]}`,
  would rebuild from the stored request's ordered hash list plus the new messages, so the cost
  grows only with the new messages. Build it only if step-5 measurements show the refs lists
  matter. ccc still has to send the replies, because only ccc sees them.

### (d) What breaks for partners and other clients

- **ccc base-URL mode:** the same gaps as proxy mode, once the rollout reaches it (the probe
  shows nothing else stops it). The ledger covers every mode, because the classifier doesn't
  depend on the mode.
- **Clients that forward Claude Code request bodies to `/v1/context_memory`:** orphan trees
  and bad compressions, until S1 ships.
- **Context Memory API partners who then call Anthropic with threads:** our compressed
  output is a new history, so they must send a `create` whenever it differs from what they
  sent last, and otherwise continue. Partner docs should say so. A
  `compressed_prefix_hash` (or an `unchanged` flag) in our answer would save them the
  comparison. Add it with the docs if partners ask for it.
- **Partner proxies (NanoGPT, OpenRouter):** these are mostly OpenAI-shaped. Threads are an
  Anthropic API feature (Claude API, Claude Platform on AWS, Anthropic-managed Google Cloud,
  Foundry), so nothing changes until they pass `thread` through. If they do, S1 is the guard.
- **Client libraries (npm/Python, tracker step 6):** give them a thread-aware helper that
  takes the full conversation and returns create-or-continue advice. Defer it until a partner
  wants it.
- **Unaffected:** the MemTree MCP tools, the benchmark harness and partner-sim (no threads),
  and count_tokens (ccc counts full bodies from the ledger).

## 3. Risks and unknowns

| # | Unknown or risk | How we settle it |
|---|---|---|
| U1 | Which users the gate turns on: an internal check this plan could not resolve, plus `tengu_curious_tower`. Seen on subscription OAuth in HTTPS-proxy mode. | Harness H1 logs `thread` across auth types. Plan for "everyone, any day". |
| U2 | Continues carry a 1-block `system`, but the docs say no `system`. | H1 against the real API. Without b2, ccc never builds continues, so this only matters if we build b2. |
| U3 | The server TTL Claude Code expects for closed turns may be longer than 5 min. | H1: idle 6 min, then see whether Claude Code sends a continue and whether it gets a 404. |
| U4 | Claude Code's thinking-drop logic re-creating, or holding stateless, after a compressed create. | H3 on Opus 5.5 with thinking on. |
| U5 | The environment variable is undocumented and may be renamed or dropped. | The proxy-side 400 backstop (step 0b) doesn't depend on it. |
| U6 | Reading the response stream adds CPU and memory to the hot path. | Accumulate only the main and agent lanes, and only when `thread` was sent. Benchmark on a 1M-token session. |
| R1 | A ledger bug indexes a wrong conversation. | Shadow mode (step 2): compare the ledger with the full body of the next create and with the transcript, and log mismatches before anything reads the ledger. |
| R2 | A fake 404 loop. | At most one per anchor, then `thread_unsupported_request`. |
| R3 | A ccc retry path resends a continue. | Rule 3 plus a test for each resend path. |

## 4. Steps (each a small PR behind a flag, default off unless noted)

| # | Step | Flag | Test |
|---|---|---|---|
| 0a | Stop-gap: `CLAUDE_CODE_TETHER_LIVE=0` in proxy and desktop mode (other agent, in flight). **Add base-URL mode.** | on | the agent's own tests |
| 0b | Backstop: when threads are meant to be off, answer a request with `thread` with 400 `thread_unsupported_request` (`x-should-retry: false`, a ccc-specific message) | on | proxy unit test; the probe as an e2e |
| 1 | Telemetry: reqlog records `thread.type`, the anchor, tail length, whether the ledger had it, and fake 404s | always | unit |
| 2 | Ledger plus stream accumulator, **shadow only**: build it, compare it with the next create and with the transcript, log mismatches | `CCC_MESSAGE_THREADS=shadow` | golden SSE fixtures (text, thinking + signature, tool_use, refusal, fallback, a dropped stream); ledger unit tests |
| 3 | Continues pass through (stop-gap off) and the ledger feeds `noteMainConversation`, tool-turn `indexInBackground` and the final index | `CCC_MESSAGE_THREADS=1` | proxy tests: a tool loop of continues indexes the full conversation; the final index includes the last loop |
| 4 | Budget check on continues from reported usage; a fake 404 at the budget; the loop guard; rule 3 on every resend path | same | proxy tests: a crossing on a continue gives 404, then a compressed create, then continues on it |
| 5 | Server S1: reject continue bodies on `/v1/context_memory` | polychat, on | `polychat_test` on the route |
| 6 | Harness runs H1-H5 on staging, then a week of dogfooding with the flag on | | below |
| 7 | Default `CCC_MESSAGE_THREADS=1` (Craig decides); later S2 and the partner docs | | |

### Harness (real Claude Code)

This extends `scripts/smoke/run.mjs` with an HTTPS-proxy-mode scenario. The existing smoke
tests use base-URL mode, and with `CLAUDE_CODE_TETHER_LIVE=1` that works for threads too, per
the probe. It needs a recording front proxy, real `api.anthropic.com` (Haiku, cheap), staging
MemTree, a small `CCC_BUDGET_TOKENS` so crossings happen in a few turns, and
`CLAUDE_CODE_TETHER_LIVE=1` so the result doesn't depend on GrowthBook.

- **H1:** a 15-step Bash loop, then a 6-minute idle, then a human turn. Check: creates and
  continues as expected, no upstream `thread_*` 400s, what the 1-block `system` is, and the TTL
  behaviour (U2, U3).
- **H2:** after the session, the ledger's conversation equals the transcript's, and equals the
  same scripted session run with threads off, up to Claude Code's per-request reminders. The
  MemTree tree covers the last loop. The final index is the full conversation.
- **H3:** a budget crossing during a continue gives a fake 404, then a compressed create,
  then continues anchored on its id. Run it on Opus 5.5 with thinking on (U4).
- **H4:** cache: `cache_read_input_tokens` on continues after a compressed create, and on a
  replay create of unchanged bytes.
- **H5:** kill and restart ccc mid-loop (desktop service). The first continue gets the fake
  404, then a create; it recovers in one round trip.

## Sources

- [Message threads docs][docs] (fetched 2026-11-14); [release notes][rn], the November 2,
  2026 entry.
- Claude Code 2.1.325 binary strings: `[tether]` log lines, `tengu_tether_decision`,
  `tengu_tether_live_outcome`, `tengu_curious_tower`, `tengu_jaunty_charm`,
  `tengu_quiet_heron`, the `CLAUDE_CODE_TETHER_LIVE` env shape, and the beta registry entry
  `message_threads` -> `message-threads-2026-08-12`.
- ccc PR #73 (HTTPS-proxy mode), PR #75 / b506bac (`notSessionConversation`, fragments).
- polychat `docs/memtree_delta_upload.md`; the tracker in
  `plans/2026-09-26_PLAN_conversation_messages_in_postgres.md`.

[docs]: https://platform.claude.com/docs/en/build-with-claude/message-threads
[rn]: https://platform.claude.com/docs/en/release-notes/overview
