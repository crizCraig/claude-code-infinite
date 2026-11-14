# Message threads: ccc and MemTree with Anthropic's server-held conversations

Status: plan (2026-11-14), revised after review rounds 1-5 (Opus and Codex). Nothing here has
shipped. The stop-gap that turns threads off is being built separately (worktree
`proxy-threads-off`; coordination in `~/src/agent-bus/threads/ccc-message-threads/notes.md`).
This plan starts from that stop-gap.

Craig's ask: "Anthropic is moving to a more efficient way to transfer things. We need to get
ahead of it."

## Recommendation

1. **Ship the stop-gap now, in every mode, with a backstop that ccc controls.** Set
   `CLAUDE_CODE_TETHER_LIVE=0` in base-URL mode too, as a defence, not only in HTTPS-proxy
   and desktop mode.
   - With the variable unset, only Claude Code's `gc()` base-URL check keeps base-URL mode
     off. A release can change that check.
   - The override bypasses the check: with it set to 1, a probe showed base-URL mode sends
     threads.
   Back the variable up with a proxy-side switch:
   ccc answers any request that carries `thread` with a 400 `thread_unsupported_request`, and
   Claude Code then goes stateless for the rest of the session (probed below). Also fix the
   live size-sample bug (2.0): it already hurts whenever a continue slips through.
2. **Then let threads through, behind `CCC_MESSAGE_THREADS=1`, with ccc keeping the
   conversation itself.** ccc keeps a per-lane *thread ledger*. It holds the last `create`
   (both the conversation Claude Code sent and what ccc forwarded), every completed reply read
   from the response stream, and every continue's new messages. A reply becomes a
   continuation anchor only when it completes cleanly. The API never confirms storage, so
   that stays best-effort until the next continue succeeds. MemTree indexing, the final index and
   sizing read the ledger, so the MemTree server needs no change (delta uploads keep the upload
   small).

   When a continue would reach the budget, and only when compression could actually run, ccc
   answers that continue with a fake 404 `thread_not_found`. Claude Code at once resends the
   whole conversation as a `create`, and today's compression path compresses it. The compressed
   create starts the server's new thread, and later continues add to it. This is the
   compaction recipe Anthropic documents. ccc does the same on `/memtree-compact` and when the
   compaction policy changes.
3. **Server: make one small change now, write the partner docs, and add one optional change
   later.**
   - Now: `/v1/context_memory` stops treating a continue tail as a whole conversation.
   - Partner docs: say when to create a thread and when to continue one.
   - Later, only if refs lists get large: an "append" mode that mirrors Anthropic's continue.

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
  with only the messages after that response. The list is empty when resuming a `pause_turn`.
  Fields come in three groups:
  - Create-only: `system` and `tools`. The docs say sending either one on a continue gives a
    400, even as `null`.
  - Fixed, sent with the same value every time:
    - `model`, `tool_choice`, `thinking`, `context_management`, `output_config`
    - `mcp_servers` (except each server's authorization token), the `skills` in `container`
    - top-level `cache_control`, the set of `anthropic-beta` values
    - whether `fallbacks` is present (its value may change)

    A change gives 400 `thread_fingerprint_mismatch`, and the message names the fields.
  - Free: `max_tokens`, `stream`, `metadata`, and so on.

  The API does not check the new messages against the ones it already holds.
- **Append-only, linear.** Each response id can be continued once (400
  `thread_already_continued`), and only after `message_stop` (400 `thread_continue_in_flight`
  while another continue from it runs). To edit, branch or compact, you start a new thread
  with a `create`. The docs say this outright under "Compact a conversation": "start a new
  thread from the summary ... in a new create request with `system` and `tools`." **So a
  client may start a thread from a modified or compressed history, and the API never compares
  it with any earlier thread.**
- **Lifetime.** A thread expires 5 minutes after its last request, and each stored response
  restarts the clock. It is deleted no more than 1 hour after its last use. It is held only in
  memory and is not ZDR- or HIPAA-eligible. There is no API to list, read or delete a thread.
- **When a continue fails** the answer is 404 `thread_not_found`, and the client replays the
  full conversation as a new `create`. The causes include:
  - expiry
  - a reply still generating
  - a turn that was served but not stored (for example, a tool call cut off by `max_tokens`)
  - a reply written by a fallback model
  - a different key, workspace or user
  - a first image added to a thread that had none

  After a refusal the client must not continue: the refused turn "might already" be stored.
  The client is the source of truth: "Keep your own copy of every message".
- **Caching and billing.** "Threads do not change pricing or rate limits." "A thread does
  not cache your prompt for you": breakpoints work as they do without a thread. There are at
  most 4 `cache_control` breakpoints per request, and the **top-level `cache_control` counts
  as one**. The `system`/`tools` breakpoints from the create count again on every continue.
  One too many gives 400 `thread_unsupported_request`. Errors are returned before the model
  runs and cost no tokens.
- **Not supported:** batches, `count_tokens` with `thread`, compaction/compaction-on-demand,
  context editing other than `clear_thinking_20251015` with `keep: "all"`, and HIPAA or
  inference-hook orgs. Thinking blocks: if a new create changes `system` or `tools`, drop the
  `thinking` blocks on Opus/Sonnet/Haiku 5.5, Fable/Mythos 5.1 and 5.2.

### What Claude Code 2.1.325 does

Source: strings from the native binary `~/.local/share/claude/versions/2.1.325`. The internal
name is "tether", and the log lines start with `[tether]`. The probe below confirms the parts
marked *(probed)*.

- **Who gets threads.** All of these must hold first:
  - the first-party provider
  - experimental betas on: not `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, and not HIPAA
  - not ZDR (`tengu_twinkly_sunrise`)

  Then `CLAUDE_CODE_TETHER_LIVE`, a tri-state environment variable, decides when it is set:
  `0` forces threads off, `1` turns them on. Unset, two more checks apply:
  - `Gt() || gc()`. `Gt()` is diskless mode (`launchOptions.diskless()`). `gc()` is true
    when `ANTHROPIC_BASE_URL` is unset or its host is `api.anthropic.com`. So an ordinary
    localhost base URL (ccc base-URL mode) fails here. HTTPS-proxy mode leaves the base URL
    unset, so it passes.
  - The GrowthBook flag `tengu_curious_tower`.

  Also excluded: models in `tengu_curious_tower_stateless_models`,
  `CLAUDE_CODE_SIMULATE_PROXY_USAGE`, and teleport/relay states. The main lane and each
  subagent get their own thread (keyed by agent id). Side queries and hook agents never get
  one.
- **Create or continue.** For each agent, Claude Code keeps a hash of each fixed config field
  and one hash per message. The fields are model, system, tools, betas, latched headers,
  thinking, tool_choice, effort and extra body.
  - Continue: only when the new history *strictly appends* to what it last sent, and no field
    changed.
  - Create, with a reason: `first_request`, `no_continue_pointer`, `config_changed`,
    `history_reshaped` (/compact, snip, tool-result clearing, abort strip), or
    `history_rewound` (rewind, /clear).
  - Create, forced: a missing or incomplete anchor, transcript drift, a presumed expiry, or
    citations the continue would drop.
  - Stateless (no `thread`): server tool use or `search_result` citations in history; tools
    added or removed mid-conversation (behind `tengu_lucid_anchor`); ephemeral messages; a
    model already held stateless.
- **Expiry estimate.** Claude Code tracks idle time per thread on the client.
  - The TTL is `tengu_jaunty_charm.ttl_seconds` (default 300).
  - A separate `cc_closed_turn_ttl_seconds` applies when the anchor reply did not end in a tool
    call.
  - A value outside 300-3600 s is discarded, not clamped. So is a closed-turn TTL shorter
    than `ttl_seconds`. With no valid TTL, no create is ever presumed expired.
  - Past the TTL it sends a `create` ("thread idle for N s ... sending a create").

  So Claude Code may expect a longer server TTL than the public 5 minutes for turns waiting on
  a human.
- **Inherited fields.** On a continue, behind `tengu_quiet_heron`, Claude Code leaves out
  `tools`. It sends only the billing-header block of `system` *(probed: 1 block, 219 chars,
  against 4 blocks / 29 KB on the create)*. The docs say any `system` on a continue is a 400,
  so either the server accepts that block from Claude Code, or it isn't the billing header:
  **unknown U2**.

  A fingerprint mismatch that names `system` or `tools` (or whose message can't be parsed)
  trips a breaker. Claude Code then sends full fields on continues for the rest of the
  session.
- **Error handling.**
  - A 404 whose `error.details.error_code` (or message) is `thread_not_found` makes Claude
    Code replay the turn as a `create` *(probed)*. So do `thread_fingerprint_mismatch`,
    `thread_already_continued`, and any other thread 400 on a continue.
  - A 400 `thread_unsupported_request` (or another thread 400 on a create) resends the turn
    without `thread`. It also marks that agent and model stateless for the session
    *(probed)*.
  - An unrecognised 400 on a request that carried the header is resent once without the
    header.
  - *(inferred from the strings, not probed; H5 checks it with a mock 529 on a continue)*
    Ordinary retries (5xx, network) resend the request already planned, the same continue
    included. Only a thread error forces a create. The ledger transactions are safe either way.
  - The server can report "thinking dropped for prefix mismatch" (`input_transformations`,
    behind `tengu_wondrous_acorn`). That can make Claude Code re-create the thread, or hold it
    stateless.

### Probe (2026-11-14, real `claude -p` 2.1.325 against a mock upstream)

The mock is `mock.mjs` in this session's scratchpad (see the coordination notes). It uses
base-URL mode, an API key and `CLAUDE_CODE_TETHER_LIVE=1`, and runs a four-step Bash tool loop.

| Run | Requests seen |
|---|---|
| plain | `create` (1 msg, 12 tools, 4-block system); then 4 x `continue` (1 msg: the tool result, no `tools`, 1-block system), each anchored on the previous mock id |
| 404 on the first continue | `create`; `continue` -> 404; **`create` with all 3 messages, `tools` and full `system`**; then continues from the new id |
| 400 `thread_unsupported_request` on the create | `create` -> 400; the same turn without `thread`; every later request without `thread` (1, 3, 5, 7, 9 messages) |

The 400 in the probe had no `x-should-retry` header. Step 0b must ship the exact response
that was probed, or probe its own shape first.

What the probe settles:

- With the override set to 1, base-URL mode sends threads. Unset, it is kept off by the
  base-URL check (`gc()`), which is a client-side rule that a release can change, not a
  property of the API. The harness covers the unset case too (H6).
- A proxy can ask Claude Code for the full conversation whenever it wants, at the cost of one
  local round trip.
- A proxy can turn threads off for a session without the environment variable.

## 2. Options for ccc

### 2.0 Today (main b506bac)

PR #75 classifies `thread: {type: "continue"}` as `thread-continue`: a *fragment*. Fragments
are forwarded unchanged, with no compression, route, recovery or MemTree upload, and they
never replace the noted conversation. A `create` is a full request and goes through the normal
path, so it may be compressed or ride the stable prefix. With threads on:

- **What works, by accident.** If ccc compressed the create, the server's thread holds the
  compressed history, and Claude Code's continues add to it. That is the same as riding the
  stable prefix.
- **What breaks:**
  1. No budget check ever runs on a continue. A long tool loop, or human turns less than 5
     minutes apart, can grow the server's thread past the model window. `DISABLE_AUTO_COMPACT`
     is on under ccc, so Claude Code won't compact for us.
  2. Nothing after the last create is indexed.
  3. The final index sends the last create's conversation and misses the rest.
  4. **Size samples are corrupted (live today).** The fragment path still records a
     whole-request size sample (`noteWholeRequestSize`, proxy.ts around 2826). That pairs the
     *tail's* bytes with the *thread's* reported input tokens, in the same `passthroughSizes`
     and `laneSizes` slots that creates are estimated from.
     - With a large tail, the ratio passes `plausibleSample` and is kept. For example, a
       300 KB tool result against 300k thread tokens gives about 1 token per byte. The next
       create is then overestimated and compressed or counted for no reason.
     - With a small tail, the sample is dropped.

     **Fix it with the stop-gap:** never record a size sample from a continue.
  5. ccc's own `count_tokens` of a continue counts only the tail (`thread` is not in
     `COUNTABLE_FIELDS`).

### (a) Rebuild the full conversation for MemTree: the thread ledger

A continue tail does **not** include the reply it continues from: Claude Code never resends
it. Rebuilding therefore needs the replies.

| Source | Exact wire form | Available | Verdict |
|---|---|---|---|
| Stored create + **replies read from the response stream** + tails | the stream form of each reply (thinking signatures, tool ids). Claude Code may later resend a reply in its own form (text runs joined, `wireToolInputs.textAsWritten`, reminder delivery). | for every request ccc forwards | **primary** |
| Claude Code's session transcript (`~/.claude/projects/.../<session>.jsonl`; ccc already reads it for the final reply and message times) | no (local form: reminders, splits by `message.id`, cleared tool results) | written after the reply, so it races | cross-check, and the final-index fallback |
| Force a create (fake 404) whenever the full body is needed | yes (Claude Code's own replay) | any request time, but never at Stop | for budget crossings, policy changes, and ledger repair |

**One ledger per (session, lane or agent id)**, capped at 128 entries like Claude Code's own
threads (memory is under U6). It holds three views, and each consumer uses one:

| View | Contents | Used by |
|---|---|---|
| `conversation` | the create's messages as Claude Code sent them, then committed replies and tails | MemTree: `noteMainConversation`, `indexInBackground`, the final index, after `normalizeMessagesForMemtree` (which drops reasoning blocks) |
| `upstream` | the forwarded create's body minus `thread` (its `system`, `tools` and messages as ccc *forwarded* them, compressed or ridden), then the same replies and tails | sizing only: estimates, and `count_tokens` without `thread`. Never sent to MemTree (it may be a compressed fragment) |
| `anchor` | `generation`, `tipId`, `tipUsage` (the tip reply's reported prompt tokens plus output), the last create's system/tools/fixed-field hash | continue matching and budget checks |

**Transactions.** Claude Code resends the same continue after a dropped stream, a 5xx or
ccc's own 503 index-wait answer, so nothing is appended when a request merely arrives.

- **Create:** start a new `generation`, reset both message views, and clear `tipId`. On each
  create, the replies Claude Code resends replace the stream-form replies the ledger held. So
  the ledger always converges on Claude Code's own form at the next create.
- **Continue whose `previous_message_id === tipId`:** *stage* the tail under
  (generation, anchor). A second request on the same anchor replaces the staged tail and
  never appends. Two requests in flight on one anchor (concurrent) leave the ledger dirty
  until the next create.
- **Response:** read the stream from a tee of the bytes ccc already forwards. Decompress as
  ccc does for usage today. Non-streaming JSON replies are handled too.
  - `message_start` gives the id.
  - `content_block_start/delta/stop` build the blocks, including `signature_delta` and
    `input_json_delta`.
  - `message_delta` gives `stop_reason` and usage.

  Commit the staged tail and the reply together, and move `tipId` to the reply's id, only
  when all of these hold:
  - the stream reached `message_stop`
  - `stop_reason` is set and is not `refusal`
  - no tool call was cut off by `max_tokens`
  - there is no `fallback_message` in `usage.iterations`

  A completion from an older `generation` is dropped. The API never acknowledges storage,
  so "committed" means only that the reply may be continued from. **What happened and what
  can be continued are tracked separately:**
  - A reply that completed but can't be continued from is still *retained*: a fallback-model
    reply, a refusal, or a cut-off tool call. Its tail and reply are kept in an
    `observed` suffix of the `conversation` view, marked uncommitted, and `tipId` is left
    empty. MemTree indexing and the final index read `conversation` *including* `observed`,
    so a session that ends on such a turn (Stop with no later create) still indexes its last
    tail and reply.
  - An interrupted stream keeps its tail and whatever text arrived, also in `observed`, as
    Claude Code's own transcript does.
  - The next create replaces `observed` with Claude Code's own version.
  - **Delivery is tracked apart from upstream completion.** The tee can see `message_stop`
    while the downstream connection to Claude Code fails, as the forwarding code already
    distinguishes. Such a reply is held as *delivery-uncertain*.
    - A later continue anchored on its id confirms receipt (the fast tool-loop case).
    - A create reconciles it, since Claude Code's own version replaces it.
    - If the session ends first, the final index reconciles the uncertain suffix against
      Claude Code's transcript (its partial reply) instead of the ledger. That is needed
      because `withFinalReply` appends nothing after an assistant message.
    - A fixture covers it: ccc sees the full reply, the client gets part of it, then the
      session exits with no create.
  - A new attempt on the same anchor (a resent continue after an interrupted stream) clears
    `observed` along with the staged tail. So a partial reply and its retry are never both
    indexed.
  - A refused turn in `observed` goes only to the final index, never to ordinary index
    uploads. Claude Code usually drops or rephrases it in the next create, which MemTree would
    otherwise see as a history rewrite.
  - Today's transcript fallback (`withFinalReply`) appends nothing when the history already
    ends with an assistant, so the ledger itself must hold these turns.
  - Claude Code normally sends a create after such a reply. If it doesn't, the next continue
    gets a fake 404.
- **Mismatch** (an unknown anchor, ccc restarted, a reply ccc couldn't parse, a dirty
  ledger, a lane ccc never saw): answer the fake 404, and the create that follows rebuilds the
  ledger. **Repair bound:** count unsuccessful repairs across generations and anchors, that is
  a create whose next reply still leaves the ledger unusable. After 2 in a row, the lane gets
  `thread_unsupported_request` and goes back to stateless, today's full-request path. Budget
  episodes (2b) have their own bound.

**Shadow first.** In step 2 nothing reads the ledger. Shadow mode still has threads on for
the user, so it carries the ledger-free budget guard in step 2's row, and it runs only in the
harness and in opt-in dogfood sessions. Not every create is a replay. Claude
Code also sends creates for `history_reshaped` (/compact, snip, tool-result clearing, abort
strip), `history_rewound` (rewind, /clear) and `config_changed`, and it doesn't put the
reason on the wire.

- **Scored:** only creates ccc knows are replays. That means the create that answers ccc's
  own fake 404, which shadow mode forces every N continues so there are replays to sample.
  - When ccc answers a continue with the fake 404, it takes a **comparison snapshot**:
    `conversation` plus that rejected continue's tail (a human message, tool results, or an
    empty `pause_turn` tail).
  - The snapshot is bound to that replay episode. The replay create is compared with it
    *before* the ledger resets. For example, ledger `[u1, a1]` plus rejected tail `u2` must
    equal the replay's `[u1, a1, u2]`.
  - Fixtures cover each tail kind.
- **Classified, never scored:** every other create, by prefix. If the normalized prefix
  matches the ledger, it is a replay. If it diverges, it is logged as a reshape with the first
  changed index, and the ledger simply resets from it.

`normalizeMessagesForMemtree` drops only reasoning blocks, so the comparison has its own
normalization. It separates harmless wire formatting from missing or changed content:

- Removed: `cache_control` only where the API defines it, on content blocks, `system`
  blocks and tools (the same places route-identity.ts strips). Claude Code moves breakpoints
  on each replay, while the ledger keeps the markers each tail carried. A `cache_control` key
  inside `tool_use.input` or a tool result is data and is kept. A negative fixture, a changed
  nested `input.cache_control`, must still count as a mismatch.
- Removed: the billing-header system block, and `thinking`/`redacted_thinking` blocks (MemTree
  drops these anyway).
- Rejoined: adjacent text blocks of one assistant reply are joined.
- Re-serialized: tool `input` is parsed and serialized canonically, to absorb
  `wireToolInputs.textAsWritten`.
- Alignment: by role sequence and `tool_use` ids, so per-request reminder text that Claude
  Code adds or moves is reported as "reminder" and is not a mismatch.

Anything left over (a missing or extra message, changed text or a changed tool result, a
different tool id) is a mismatch, counted by cause. Deterministic fixtures cover moving cache
markers, joined text runs, rewritten tool inputs and reminders. A lane that mismatches stops
feeding MemTree from the ledger until the next create repairs it. Step 3 needs zero
content mismatches on known replays across the shadow week, not "an acceptable rate".
Fixtures cover creates after tool-result clearing, /compact and rewind, which must classify as
reshapes and not as mismatches.

Uploads: with delta uploads on (`CCC_MEMTREE_DELTA=1`, tracker step 4), ordinary index calls
send refs for messages the server acked, plus everything else inline. Those savings are
steady-state and apply to acknowledged content only:

- The **final index sends no refs** (memtree.ts disables message refs there), so it is a full
  upload, as it is today.
- Unacked or unservable messages, such as those with redacted secrets or unserved images,
  are re-sent inline each time, per the delta contract.
- A reply whose stream form differs from Claude Code's form is re-sent when the next create
  replaces it.

The harness measures the full payload (H2).

### (b) Compression with threads

- **(b1, recommended) Fake 404, then today's path.**
  - **Estimate:** take the server's thread size from `anchor.tipUsage` (the tip reply's
    `input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens`),
    and add an estimate of the tail. This is a new per-thread sample, not the lane's
    whole-request samples.
  - **Under the budget:** forward the continue unchanged. Keep background compression (from
    about 850k) working on continues.
    - **Input:** `maybePrepareCompression` compresses the ORIGINAL conversation, as
      `recoverLate` does. So it gets the ledger's `conversation` view, normalized as today,
      with its hash, never the `upstream` view.
    - **Trigger:** the `upstream` size (`anchor.tipUsage` plus the tail).
    - **Setup:** `maybePrepareCompression` returns early without `rec.compaction`, so the
      continue path builds that itself.
    - **Scope:** main lane only, as today.
    - **Test:** a loop of continues passes `prepareStartTokens` and prepares in the background.
      At the budget, the fake-404 replay create rides the prepared result. Repeat this across a
      **second** compression cycle: after the first compressed create, `upstream` starts with
      the flattened memory message, but preparation still compresses `conversation`, and its
      prefix identities match Claude Code's next full create.
    - **Identities:** `preparedFromResult` keys a preparation by today's message identities.
      Those don't join adjacent assistant text blocks, so a stream-form reply (split text)
      would fail `prefixMessageMatches` against Claude Code's joined replay. Paid preparation
      would then be thrown away for a second blocking compress. So prepare only from a prefix
      in Claude Code's own form, ending at the last create. Then extend it with ledger replies
      only after each one is rewritten into the form Claude Code replays: text runs joined,
      tool input as written, the rules the shadow comparison already checks. Messages the
      ledger can't put in that form stay out of the prepared prefix and go in the kept tail.
    - **Test:** split and joined replies go through preparation, then the fake 404, then
      adoption, across both compression cycles.
  - **At the budget, and only when compression can actually run:** answer the fake 404. Claude
    Code sends the full create, and the tool-turn or edge compaction we have today compresses
    it, or rides the prepared result. Compression can run when no attempt is in flight for the
    lane, the index is not behind, the lane is not in backoff or cooldown, and tool-route
    recovery is not disabled.
  - **At the budget, but compression can't run:** forward the continue. The thread grows a
    little past the budget, as a forwarded whole request does today. If it nears the model
    window, answer `thread_unsupported_request`, and the lane goes stateless and back to
    today's full-request path.
  - **The intent travels with the replay.** Carry the reason ("budget", "manual",
    "policy" or "repair") from the 404 to the create. After the create, check what was
    actually delivered. If a budget replay did not shrink the thread below the budget (an
    unchanged ride, MemTree degraded), count it as an unsuccessful episode.
  - **Loop bound:** two unsuccessful episodes in a row on a lane, even across new anchors,
    answer `thread_unsupported_request` (stateless for the session).
  - **The result:** the compressed create starts the new thread (keeping
    `thread: {type: "create"}` and the headers as sent), and Claude Code's continues add to
    it. ccc builds no continue and no create body itself.
- **Explicit controls force a replay below the budget too.** These change what ccc would
  deliver without changing Claude Code's thread config:
  - `/memtree-compact`
  - a compaction-target change
  - `/memtree-compact off` and `on`

  Each one invalidates the lane's thread. Its next continue gets the fake 404, with the
  reason "manual" or "policy".
- **(b2) ccc turns the continue into a create itself**, from the ledger, its stored
  `system`/`tools` and the fixed fields. This saves the extra round trip and the localhost
  upload, but it duplicates Claude Code's request building. Do it only if harness timing
  shows b1's extra round trip matters. It won't, next to a blocking MemTree compress call.

**Cache and cost.** Threads change neither pricing nor caching.

- A compressed create misses the cache for the new compressed prefix and writes it, exactly as
  today's compaction does. After that, continues read the cache through Claude Code's own
  breakpoints.
- A replay create of *unchanged* bytes (after an expiry, or a repair 404) should read the
  cache warmed by the thread's turns, because the cache is keyed by content, not by thread.
  Verify this in the harness (H4).
- If Claude Code itself sends a create later (on expiry), ccc rides the stable prefix byte
  for byte, as it does today. That holds only while the prefix is still compatible:
  `prefixMismatch` refuses a changed system prompt, so after a config change the create
  compresses again, as it does today.
- What a forced create loses is that turn's TTFT and bandwidth gain. So threads on with
  forced creates send at most what threads off sends today, and they avoid the full upload on
  the other turns.

**Rules ccc must keep on threaded requests:**

1. **Fixed fields.** Never change one between a create and its continues: model, betas,
   `context_management`, top-level `cache_control`, and so on. ccc forwards headers and these
   body fields unchanged today. Keep it that way.
2. **Count breakpoints the way a thread does.** `capCacheBreakpoints` (route-cache.ts)
   ignores the top-level `cache_control`. A compressed create keeps `...body`, and with it a
   top-level marker, then adds the flatten breakpoint and caps blocks at 4. The total can be
   5, which gives 400 `thread_unsupported_request` and silently makes the lane stateless.
   When `thread` is present, count the top-level marker and check the *delivered* create.
   Then check what its continues will carry: the create's `system`/`tools` markers, the
   top-level marker and the tail's markers, all within 4. Test both.
3. **Never send one continue twice.** A route-fallback retry, an A/B or speculative send, or
   a recovery resend would hit `thread_already_continued` or `thread_continue_in_flight`.
   Any path that would resend a continue answers the fake 404 instead.
4. **ccc does change `system`, so U2 matters for b1.** `buildCompressedBody` lifts the
   `system` MemTree returns into the create. On the server, polychat consolidates system
   messages and `trim_large_system_prompt` cuts a system over 60k characters
   (docs/context_memory_request_pipeline.md in polychat). On rides, `currentRouteSystem`
   swaps or strips billing headers. So the thread can store a `system` that differs from
   Claude Code's. Its continues then send Claude Code's own 1-block system.
   - Whether the server accepts that block over a ccc-altered stored system is U2.
   - If the server refuses with a fingerprint mismatch naming `system`, Claude Code trips its
     breaker and sends the full system on every continue, which the docs say is a 400.
   - A changed system also brings the thinking-drop rule into play. Flattening hides it today,
     but not in the kept tail of a ride.

   H3 must check continues after a compressed create and after a ride create.

### (c) MemTree server changes

- **None are needed for (a)+(b1).** ccc rebuilds the full conversation and uploads it as it
  does today, with delta refs (`docs/memtree_delta_upload.md` in polychat; tracker steps 0-5 in
  `plans/2026-09-26_PLAN_conversation_messages_in_postgres.md`). Turning deltas on in prod
  (tracker step 5: `CONVERSATION_STORE`, then `CONVERSATION_STORE_DELTA`, then a ccc release)
  is the matching win on the MemTree side, and with threads on it matters more.
- **S1 (small, do it).** Today `/v1/context_memory` would take a continue tail as a whole
  conversation: a new `first_msg_prefix_hash`, an orphan tree, and a "compression" of a
  fragment. This is the PR #75 bug moved to the server, and any client or partner that
  forwards Claude Code bodies can trigger it.
  - The server stops storing and indexing a body with `thread.type == "continue"`.
  - S1 guards only clients that forward raw Claude Code bodies. It is not a fix for old ccc
    releases: ccc never sends a `thread` field to MemTree (it uploads
    `messagesWithSystem(messages, system)`), so the server can't spot a pre-#75 release's
    fragment uploads.
  - Current ccc degrades to passthrough on any failure from `/v1/context_memory` (`compress()`
    returns null, memtree.ts). For ccc, a 400 that says to send the full conversation (or
    message refs) is therefore safe.
  - For partners, whose fallback we don't know, answer with the messages unchanged plus a
    `thread_fragment` warning instead of a 400, unless a partner confirms it degrades on 4xx.
  - A `thread: {type: "create"}` field is harmless, so ignore it.
- **S2 (later, optional): MemTree append mode.** Today a delta upload still lists one ref per
  message: about 70 bytes each, so about 140 KB for a 2,000-message session, capped at 50,000
  refs. An append form would rebuild from the stored request's ordered hash list plus the new
  messages, so its cost grows only with the new messages:
  `{"memtree_append": {"after_request": <ack id>}, "messages": [new]}`. Build it only if
  step-5 measurements show the refs lists matter. ccc still has to send the replies, because
  only ccc sees them.

### (d) What breaks for partners and other clients

- **ccc base-URL mode:** kept off today by Claude Code's base-URL check (`gc()`). If a
  release relaxes that check, it gets the same gaps as proxy mode. The ledger covers every mode, because the classifier doesn't
  depend on the mode.
- **Clients that forward Claude Code request bodies to `/v1/context_memory`:** orphan trees
  and bad compressions, until S1 ships.
- **Context Memory API partners who then call Anthropic with threads:** our compressed
  output is a new history. They must send a `create` whenever it differs from what they sent
  last, and otherwise continue. Partner docs should say so. A `compressed_prefix_hash` (or an
  `unchanged` flag) in our answer would save them the comparison. Add it with the docs if
  partners ask for it.
- **Partner proxies (NanoGPT, OpenRouter):** these are mostly OpenAI-shaped. Threads are an
  Anthropic API feature (Claude API, Claude Platform on AWS, Anthropic-managed Google Cloud,
  Foundry), so nothing changes until they pass `thread` through. If they do, S1 is the guard.
- **Client libraries:** give the npm package (tracker step 6) and the Python library (step 7)
  a thread-aware helper. It would take the full conversation and advise create or continue.
  Defer it until a partner wants it.
- **Unaffected:** the MemTree MCP tools, and the benchmark harness and partner-sim (they use
  no threads). `count_tokens` is unaffected once every sizing path uses the ledger's
  `upstream` view (2.0 item 5).

## 3. Risks and unknowns

| # | Unknown or risk | How we settle it |
|---|---|---|
| U1 | Which users the gate turns on: `Gt()`/`gc()` (diskless mode, or no custom base URL; read from the binary, not yet run with the override unset) plus `tengu_curious_tower`. Seen on subscription OAuth in HTTPS-proxy mode. `TETHER_LIVE=1` still needs first-party, experimental betas and a non-ZDR org. | Real-API acceptance (H6) across auth types and models. Plan for "everyone, any day". |
| U2 | Continues carry a 1-block `system`, but the docs say no `system`. The thread's stored system can differ from Claude Code's (rule 4). | H1 and H3 against the real API, after a compressed create and after a ride create. |
| U3 | The server TTL Claude Code expects for closed turns may be longer than 5 min. | H1 with a persistent process: idle 6 min, then see whether Claude Code continues and whether it gets a 404. |
| U4 | Claude Code's thinking-drop logic re-creating, or holding stateless, after a compressed create. | H3 on Opus 5.5 with thinking on. |
| U5 | The environment variable is undocumented and may be renamed or dropped. | The proxy-side 400 backstop (step 0b) doesn't depend on it. |
| U6 | The cost of reading the stream and holding up to 128 lanes of two message views. | Read only when `thread` was sent, on the main and agent lanes. Share message objects between the views. Benchmark on a 1M-token session. |
| R1 | A ledger bug indexes a wrong conversation. | Transactions (2a), then shadow mode with a mismatch-rate gate before anything reads the ledger. |
| R2 | A fake 404 loop. | The episode bound across anchors, and fake 404s only when compression can run (2b). |
| R3 | A ccc retry path resends a continue. | Rule 3, plus a test for each resend path. |
| R4 | A breakpoint over the limit silently makes the lane stateless. | Rule 2, plus reqlog counting `thread_unsupported_request` from upstream. |

## 4. Steps (each a small PR behind a flag, default off unless noted)

| # | Step | Flag | Test |
|---|---|---|---|
| 0a | Stop-gap: `CLAUDE_CODE_TETHER_LIVE=0` in proxy and desktop mode (other agent, in flight). **Add base-URL mode.** | on | the agent's own tests |
| 0b | Backstop: when threads are meant to be off, answer a request with `thread` with 400 `thread_unsupported_request`, in exactly the probed shape (re-probe before adding `x-should-retry`). No size sample from continues (2.0 item 4). | on | proxy unit tests; the probe as an e2e against the mock |
| 1 | Telemetry: reqlog records `thread.type`, the anchor, tail length, whether the ledger matched, fake 404s with their reason, and upstream `thread_*` errors | always | unit |
| 2 | Ledger with transactions, the stream reader and the three views, **shadow**: nothing reads the ledger. Score known replays (ccc's fake-404 answers, forced every N continues) and classify other creates as replays or reshapes by prefix. Shadow passes continues through, so it is **threads on for the user**, and it ships with a guard that doesn't read the ledger: at the budget (estimated from `anchor.tipUsage` plus the tail) a fake 404 when compression can run, otherwise forward; near the window, `thread_unsupported_request`. The final index stays today's (the last create plus the transcript), a known gap in shadow. Shadow runs only in the harness (H2, H5) and in opt-in dogfood sessions. | `CCC_MESSAGE_THREADS=shadow` | golden SSE fixtures: text, thinking + signature, tool_use, refusal, fallback, a tool call cut off by `max_tokens`, a dropped stream then the same continue resent, two requests in flight, a stale completion after a create, `pause_turn` with an empty tail, a non-streaming reply. Comparison fixtures: reshape creates after tool-result clearing, /compact and rewind (classified, not scored); joined text runs; rewritten tool input; moving cache markers; a changed nested `input.cache_control` (must mismatch). Guard tests: a crossing gives a fake 404; a crossing during in-flight or backoff forwards; near the window gives `thread_unsupported_request`. |
| 3+4 | Land together, because step 3 alone lets the thread grow past the window. Step 3: continues pass through, and the ledger feeds MemTree and sizing. Step 4: the budget gate with the can-compress check, carried intent, the episode bound, the manual and policy controls, rule 2 counting, and rule 3 on every resend path. | `CCC_MESSAGE_THREADS=1` | proxy tests: a tool loop of continues indexes the full conversation; the final index includes the last loop; a crossing gives 404, then a compressed create, then continues on it; a crossing during in-flight, backoff or index-wait forwards; repeated crossings; compact, target change and off/on between turns; main and agent lanes |
| 5 | Server S1 | polychat, on | `polychat_test` on the route |
| 6 | Harness H1-H6 on staging, then a week of dogfooding with the flag on | | below |
| 7 | Default `CCC_MESSAGE_THREADS=1` (Craig decides); later S2 and the partner docs | | |

### Harness

The current smoke runner (`scripts/smoke/run.mjs`) starts a separate `claude -p` process per
scenario and kills it after four minutes. These need more: **one persistent interactive
Claude Code process per scenario** (for example under a pty or tmux), driven turn by turn. They
also need ccc in HTTPS-proxy mode, a recording front proxy, a small `CCC_BUDGET_TOKENS` so
crossings happen in a few turns, and `CLAUDE_CODE_TETHER_LIVE=1`.

The oracles are deterministic. A mock upstream with scripted replies settles exact ledger
equality, and real-API runs settle only what the server accepts. Comparisons are against a
forced replay from the **same** running session, never against a second run, because model
output differs between runs.

- **H1 (real API, Haiku):** a 15-step Bash loop, a 6-minute idle in the same process, then a
  human turn. Check: creates and continues as expected, no upstream `thread_*` 400s, what the
  1-block `system` is, and the TTL behaviour (U2, U3).
- **H2 (mock):** the ledger's `conversation` view equals a forced replay in the same session,
  under the comparison normalization (2a). The final index is the full conversation, and the
  tree covers the last loop. Record the payload bytes of each index call and of the final
  index. Also cover:
  - a fallback reply, then Stop with no later create
  - an interrupted stream, then Stop or exit
  - repeated parse failures (the repair bound)
- **H3 (real API, Opus 5.5 with thinking on):** a budget crossing during a continue gives a
  fake 404, then a compressed create, then continues on its id. Also test a ride create
  followed by continues. Check for no fingerprint mismatch, no 400, and how Claude Code reacts
  to thinking drops (U2, U4).
- **H4 (real API):** `cache_read_input_tokens` on continues after a compressed create, and on
  a replay create of unchanged bytes.
- **H5 (mock):**
  - a dropped stream, then the same continue resent
  - concurrent subagents
  - a 404 during in-flight, backoff and index-wait
  - repeated crossings
  - compact, target change and off/on
  - breakpoint counts with a top-level marker
  - a ccc restart mid-loop (desktop service), which should recover in one fake 404
- **H6 (real API acceptance):** the off backstop and the probe's three runs, on subscription
  OAuth and on an API key, with the models we route.
  - Base-URL mode with `CLAUDE_CODE_TETHER_LIVE` unset: expect no `thread` (the `gc()`
    check). Check it on every Claude Code release.
  - Also send `thread_unsupported_request` on a *continue* (the probe only tried a create).
    The next body must hold every message, `tools` and the full `system`. Both the
    window-guard and loop-bound exits depend on this.
  - Also send a mock 529 on a continue (in H5), and record whether the retry is the same
    continue.

## Sources

- [Message threads docs][docs] (fetched 2026-11-14); [release notes][rn], the November 2,
  2026 entry.
- Claude Code 2.1.325 binary strings: `[tether]` log lines, `tengu_tether_decision`,
  `tengu_tether_live_outcome`, `tengu_curious_tower`, `tengu_twinkly_sunrise`,
  `tengu_jaunty_charm`, `tengu_quiet_heron`, the `CLAUDE_CODE_TETHER_LIVE` env shape, and the
  beta registry entry `message_threads` -> `message-threads-2026-08-12`.
- ccc PR #73 (HTTPS-proxy mode), PR #75 / b506bac (`notSessionConversation`, fragments);
  src/proxy.ts (`noteWholeRequestSize`, `buildCompressedBody`, `currentRouteSystem`,
  `prefixMismatch`), src/route-cache.ts, src/count-tokens.ts.
- polychat `docs/memtree_delta_upload.md`, `docs/context_memory_request_pipeline.md`; the
  tracker in `plans/2026-09-26_PLAN_conversation_messages_in_postgres.md`.
- Review round 1: `~/src/agent-bus/threads/ccc-message-threads/` (Codex `codex_r1_final.md`;
  the Opus review's findings are folded into this revision).

[docs]: https://platform.claude.com/docs/en/build-with-claude/message-threads
[rn]: https://platform.claude.com/docs/en/release-notes/overview
