<p align="center">
  <img width="470" height="214" alt="cc-inf-wide-transparent" src="https://github.com/user-attachments/assets/1524e5dc-637f-4d25-9a15-f7f7b65c8182" />
</p>

# Claude Code Infinite

Memory for long-running agents. Claude Code Infinite indexes your Claude Code sessions with
[MemTree](https://memtree.dev) so their history can be easily searched, navigated, and understood,
by you and by Claude, within a session and across all of them.

While Claude works, MemTree summarizes each new batch of messages in the background and files it
under a topic. Each topic gets its own summary, and the whole session gets one at the top. When a
session outgrows the context window, Claude works from these summaries plus your most recent
messages, so the session can keep going indefinitely. When it needs a detail, it opens a branch and
follows it down to the original messages.

* **Search across every session.** Claude can find what was decided, tried or ruled out in any of
  your past sessions, by exact words or by meaning, filtered by project and date
* **Browse each session's MemTree** in your browser, from the link `ccc` prints in the terminal
* **Replaces `/compact` without losing the thread.** In a blind-graded benchmark, MemTree matched
  full-context Claude Code and beat Claude Code's built-in `/compact` by 20 points
  ([details](#long-session-benchmark))
* **Unlimited-length sessions**, with relevant past information recalled automatically

## Search across sessions

Every `ccc` session is indexed as it runs, and Claude gets read-only `memtree` tools over all of
your indexed sessions, so you can just ask:

* "What did we decide about the retry limit last week?"
* "Find the session where we fixed the token-count bug, and show me the fix."
* "We tried this before. What went wrong last time?"

| Tool | What it does |
| --- | --- |
| `search` | Searches this session's tree or all of your sessions. Text mode (default, free) matches exact words, ids, paths and errors; vector mode matches meaning. Filter by project, `since` and `until`. |
| `list` | Lists your sessions, most recently active first, with title, first message, project (directory, repo, branch), models and times. Filter by time, project or words. |
| `read_node` | Opens a node: its summary, its path from the root, and its children. |
| `read_lines` | Reads the exact original transcript lines under a leaf. |

Hits name their node, so Claude goes from a search hit to the summary around it and then to the
exact lines. Type `/memtree-view` for the link to this session's tree. Details are under
[Memory tools](#memory-tools).

## Long-session benchmark

In a blind-graded benchmark on a 775k-token Claude Code session, MemTree matched full-context
Claude Code and beat Claude Code's built-in `/compact` by 20 points, finishing in about half the
time. That is the same score as full context with a third of the tokens.

| Setup | Score | Input tokens / run | Wall time | How it handles the history |
| --- | --- | --- | --- | --- |
| **Claude Code Infinite** | **69** | **39M** | **11–22 min** | Sent whole until the 800k budget, then compressed once to ~420k; never compacted |
| Full context | 69 | 113M | 24–54 min | Grew to ~970k and hit Claude Code's auto-compaction mid-task every round |
| `/compact` | 49 | 17M | 29–40 min | Claude Code's `/compact` before the task, 789k → 13k |

Every setup resumes the same ~775k-token history and is given one task: fix the security issues
found earlier in the session, which are listed only in the conversation. Claude Opus 5.5, 3
rounds, graded blind against a fixed answer key by an independent grader. Scores are 0–100 means
(68.7 / 69.3 / 48.7 in table order); the noise floor is 10 points, so MemTree vs full context is parity, not a
win, while MemTree was ahead of `/compact` in every round. Average wall time was 16 min
for MemTree and 38 min for full context. Input tokens count uncached, cache-read and cache-write
tokens; `/compact`'s exclude the one-time `/compact` step. This is one task family, one model and
3 rounds, not a general benchmark.

## Requirements

* [node.js 20.3 or newer](https://nodejs.org/en/download/)
* [Claude Code (the terminal version)](https://code.claude.com/docs/en/quickstart)
* **Claude Subscription** - optional but highly recommended as this offers up to 1000x cost savings vs Anthropic's API pricing

## Setup

> [!TIP]
> No Claude subscription? Use an Anthropic API key exactly as with vanilla Claude Code
> (`ANTHROPIC_API_KEY` or a Console login). `ccc` forwards it unchanged to api.anthropic.com, and
> you pay Anthropic per token.

1. Install (Node ≥ 20.3; no git needed)
  <!-- When claude-code-infinite is published to npm, switch both this install line and the
       note below to `npm install -g claude-code-infinite` in the same change as the publish. -->
  ```bash
  npm install -g https://github.com/crizCraig/claude-code-infinite/tarball/main
  ```
  The npm package (`npm install -g claude-code-infinite`) is temporarily behind — the
  version there still uses the retired `/cc` proxy. It will be current again shortly;
  until then install from the GitHub tarball above.
2. Run Claude Code Infinite with
  ```bash
  ccc
  ```

This will guide you through setting up your PolyChat key which you can also get [here](https://polychat.co/auth?memtree=true).

## Environments

The tool supports multiple environments (this selects the MemTree compression API only — Anthropic traffic always goes directly from your machine to api.anthropic.com):

- **Production** (default): `ccc` - Uses https://api.polychat.co
- **Local**: `ccc local` - Uses http://localhost:8080 for local development

Each environment maintains its own separate API key.

## Claude Code auto-compaction

`ccc` disables Claude Code's automatic conversation compaction for the Claude process it launches. MemTree manages the context sent to the model, so letting Claude Code independently summarize the full local transcript can compact a conversation MemTree already reduced. Manual `/compact` remains available.

Claude Code 2.1.219 also recommends “Resume from summary” for any old session
above a fixed 100k-token threshold, even when the active model has a 1M window
and auto-compaction is disabled. `ccc` suppresses that resume-time
recommendation as well; it does not disable the manual `/compact` command.

A session whose last response reached the verified local refusal threshold
(for example one sent whole while MemTree was unavailable) would otherwise be
refused locally with "Context limit reached" on every prompt after a resume.
On `ccc --resume <id>`, `ccc` backs the transcript up to
`~/.claude-code-infinite/transcript-backups/` and lowers that last response's
recorded usage to half the window, so the next message is sent and MemTree
compresses it.

To restore Claude Code's native auto-compaction setting for one invocation, use:

```bash
CCC_AUTO_COMPACT=1 ccc
```

Claude Code normally treats any custom `ANTHROPIC_BASE_URL` as an unverifiable
gateway and can therefore account for a resumed native-1M model as if it had a
200k window. `ccc` identifies its transparent localhost relay as trusted, so
current native-1M models retain the same context window they have when Claude
Code connects directly to Anthropic. The official
`CLAUDE_CODE_DISABLE_1M_CONTEXT=1` switch still forces the legacy 200k behavior.

## Privacy & architecture: your Anthropic credentials never leave your machine

`ccc` runs a small proxy on `127.0.0.1` and launches Claude Code with `ANTHROPIC_BASE_URL` pointed at it and automatic compaction disabled. Claude Code keeps its **native login** — token refresh, plan-default model selection, and rate-limit handling behave exactly like vanilla Claude Code, and your OAuth token is sent only to `api.anthropic.com` from your own machine.

```
Claude Code ──▶ localhost proxy (ccc)
                  ├──(messages only, MemTree API key)──▶ api.polychat.co /v1/context_memory
                  │◀──(compressed messages)─────────────┘
                  └──(compressed request + your local OAuth)──▶ api.anthropic.com
```

- Only message content is sent to MemTree for indexing/compression — never credentials.
- Anthropic requests go directly from the local proxy to api.anthropic.com using the authentication Claude Code supplied. PolyChat never sees that credential or Anthropic traffic.
- If MemTree is unreachable, slow, or your MemTree plan needs payment, `ccc` degrades to a transparent passthrough so your session is never interrupted.

### Inline notices

In interactive sessions, `ccc` reports these MemTree states as display-only lines in Claude Code:

- `✓ MemTree · conversation optimized · ~813k → 408k tokens`, with the session's newest completed MemTree page on its own line below it and a blank line before the answer, when a compressed turn reflects new indexing (MemTree's index covers more of the conversation than before) or a newly finished MemTree page. The before-count is `ccc`'s size estimate for the request that would otherwise have been sent (MemTree's `usage.raw_prompt_tokens` when `ccc` has none); the after-count is Anthropic's reported compressed input, estimated from bytes until usage arrives. Counts under a million are whole thousands, larger ones one decimal (`1.3m`). Without both counts, or when the result is not smaller, the line reads just `✓ MemTree · conversation optimized`. The line is green when terminal color is available, and plain when `NO_COLOR` or a monochrome terminal is configured. `ccc` uses the standard ANSI green foreground sequence and Node's capability detection, so the same path works in ANSI terminals on macOS/Linux and supported Windows consoles.
- `⚠ MemTree degraded — this turn ran uncompressed` when a blocking compression call fails or times out.
- `⚠ MemTree is off — payment required…` once when compression and indexing are disabled for payment.
- `• MemTree` with the page on its own line below it, once at the end of a user turn, when the turn used a MemTree index whose link has not been shown yet (the first one of the session, then each newly finished index), unless the turn's success line already showed it. The line comes from the `Stop` hook, so it lands after the turn's last message. When MemTree passed the conversation through whole because it already fits the model's budget, the label line reads `• MemTree · /memtree-compact to compact session`. The URL always gets a line to itself, so a long link does not wrap the label or note. The displayed link follows the server's newest completed tree for this session, preserving its pinned namespace and own/served selection. If that lookup is unavailable, it falls back to the compression page; that page can show a completed prefix while its own tree builds. Open it in a browser, read it as JSON with `ccc fetch <url>`, or, from an agent inside the session, `GET $ANTHROPIC_BASE_URL/memtree/<short id>.json` on the loopback proxy without handling the key. Every MemTree call carries Claude Code's session id, so `GET $ANTHROPIC_BASE_URL/memtree/sessions/<session id>.json` lists every page from one session, newest first (the session id is the `--resume` id and the name of the transcript under `~/.claude/projects/`). `/memtree` lists the MemTree commands. Type `/memtree-view` at any time to print the session's latest link. `/memtree-compact` is MemTree's replacement for Claude Code's `/compact`: your next message is sent compressed to half the budget (or `/memtree-compact 400k` for another target), and from then on the session follows the compaction rules under [How it works](#how-it-works) with that target. `/memtree-compact off` goes back to sending the conversation whole. `CCC_COMPACT_TARGET=500k` sets the target of every compaction for every session from launch, for benchmarks and headless (`-p`) runs, where the slash command is unavailable; it does not compact by itself, the budget still decides when, and `/memtree-compact off` still turns compaction off for one session. `CCC_COMPACT_TARGET=off` starts every session in the `/memtree-compact off` state instead (`/memtree-compact [N]` still turns it back on). `ccc` answers these commands locally, so they cost no model turn and nothing is added to the conversation; the compaction setting lasts for the life of the `ccc` process. When a session starts and already has a page, which in practice means a resumed one (`ccc --resume`, or `/resume` inside a running session), its latest link is shown right away: `ccc` remembers the newest page per session in `~/.claude-code-infinite/memtree-links.json` (most recent 200 sessions) and a `SessionStart` hook prints it. `CCC_MEMTREE_LINK` changes where the link appears: `turn` (default), `message` (under every finished assistant message, green when the index is new, dim otherwise), `stop` (every turn, on `Stop`), `success` (only on the line below `✓ MemTree · conversation optimized`), or `off`.

The newest-tree lookup runs in the background with a 60-second cache, at most eight outstanding fetches, and one 10-second deadline across at most 32 finder pages. `/memtree-view` and resume hooks wait at most 2.5 seconds. Servers with the finder session-ID search (polychat `0202eaa` and later, including reviewed `c67cadb`) use `/v1/memtree/sessions?q=<id>`, following cursors and accepting only the exact session ID. A missing endpoint falls back to the compression page and is not retried for 30 minutes. The older exact route `/usage/memtree/sessions/<id>.json` accepts the bearer key, but excludes index-only calls and does not report completed trees, so it cannot supply this link. No verified server version provides a suitable exact newest-completed-tree lookup yet.

`/memtree-view` emits OSC 8 hyperlinks only when the ccc proxy has a TTY and detects iTerm2 3.1+ (`TERM_PROGRAM=iTerm.app` plus its version), JetBrains (`TERMINAL_EMULATOR=JetBrains-JediTerm`), Ghostty, WezTerm, VS Code, kitty, or Windows Terminal (`WT_SESSION`). Detection happens in the proxy, before hook output is relayed through pipes. `NO_COLOR`, dumb/unknown terminals, tmux/screen, and non-TTY output get a plain URL. Apple Terminal also gets the full visible URL for its normal URL handling. The success and Stop notices retain their visible URLs, and a late lookup cannot repeat the same page already linked by that turn's success notice.

`ccc` installs a minimal session-only Claude Code plugin using the repeatable `--plugin-dir` option. Its `MessageDisplay` hook changes only what the terminal renders and never alters stored assistant content; a `Stop` hook supplies a fallback for tool-only responses. That fallback may be saved by Claude Code as non-model hook UI metadata, but it is excluded from resumed model and recap requests. Notices are never added to model context, and Anthropic responses are left untouched with one exception: the hidden recap request Claude Code sends when you come back to an idle session gets a final `• MemTree` / `<url>` text block, so the recap ends with the link (not added when `CCC_MEMTREE_LINK=off`). Claude Code keeps that recap as a UI-only system entry, never as conversation content, and the block is skipped when it would push the recap past Claude Code's 400-character cap, and `-p`/non-TTY output is left unchanged. Legacy marker cleanup remains for transcripts created by older `ccc` releases. The payment state can also produce a separate terminal warning at startup.

Claude Code currently displays the original assistant text instead of `MessageDisplay` replacements while verbose mode is enabled. Turn verbose mode off to see the inline MemTree line.

### Memory tools

Interactive `ccc` sessions also get a small MCP server, `memtree`, with four read-only tools (see [Search across sessions](#search-across-sessions)): `mcp__memtree__search` (`query`; optional `tree`, `"current"` for this session or omitted for all of your sessions; `mode` `text` (default, free) or `vector` (meaning, first page charged); `project`, `since`, `until`, `cursor`, `limit` (default 10, at most 50)), `mcp__memtree__read_node` (`node`, an address `<tree>#<id>` from search, or `id` with optional `tree`: summary, path from the root, children, leaf line range), `mcp__memtree__read_lines` (a leaf's `node`, or `block`, `start`, `end` with optional `tree`: exact transcript lines, at most 400 lines / 40k characters per call) and `mcp__memtree__list` (your sessions, most recently active first; `since`, `until`, `project`, `q`, `cursor`, `limit`). Other sessions' trees are named explicitly by reference and authorized by your MemTree key. This session's tree (`tree: "current"`, or no `tree` on `read_node`/`read_lines`) is the one the current request was served from: the server asks the `ccc` proxy for `GET $ANTHROPIC_BASE_URL/memtree/current?session=<id>` (only that session's compression source page, or its stored source page on resume; `current.json?session=<id>` returns the page itself). Completed pages are cached. If the proxy temporarily serves an older prefix while a newer tree is indexing, the tools reuse that prefix during a 45-second cooldown, then check the page again. `ccc` registers it with `--mcp-config=<temp file>`, which keeps working under `--strict-mcp-config`, and pre-allows the four read-only tools; `CCC_MEMTREE_MCP=0` turns it off. The MCP process requires `CLAUDE_CODE_SESSION_ID` and checks that both the pointer and page belong to it. If Claude Code retains an MCP process with an old session ID after `/clear` or a session switch, reconnect the MCP server with the current session ID; it cannot infer a new identity from another session using the proxy. Print (`-p`) and non-TTY runs get it only when their own `--mcp-config` names a server `memtree` run by `ccc memtree-mcp` (add `--allowedTools mcp__memtree__search,mcp__memtree__read_node,mcp__memtree__read_lines,mcp__memtree__list`). Whenever the tools are configured, compress calls carry `x-memtree-tools: search,read_node,read_lines,list` so MemTree tells the model how to use them.

## How it works

<table><tr><td>
<img width="1050" height="445" alt="image" src="https://github.com/user-attachments/assets/d1ab2456-9a64-4118-a72a-b9d133c7c8bd" />
</td></tr></table>


When you send a message, we retrieve relevant details and summaries from the prior messages in your thread. These details and summaries populate a **memory message**. Following the memory message, we append a compressed version of your recent message history. The resulting context-window is dramatically smaller, allowing Claude to process your request with much greater efficacy, lower latency, and reduced cost.

**Compaction keeps a stable prefix.** While a conversation fits the model's budget (800k tokens for Opus 5.5), it is sent whole. When a request reaches the budget, `ccc` compresses it once, to half the budget (or your `/memtree-compact N`), and keeps those compressed bytes as the session's prefix. Every later request, human turns included, is that same prefix followed by the messages that came after it, verbatim, with no compression call (MemTree still indexes in the background). Because the prefix does not change, Anthropic reads it from the prompt cache on every turn after the one that compacted, instead of writing the whole compressed context again. `ccc` compresses again only when prefix plus newer turns reach the budget (measured from the size Anthropic reported for the previous request, plus an estimate for what was added), or when the messages the prefix stands for change (rewind, edit, fork, `/clear`). If that recompression fails, the turn is sent on the old prefix rather than the whole history. The budget is the one MemTree reports for the model; until the server reports one, `ccc` uses 80% of the model's context window. `CCC_BUDGET_TOKENS=60k` overrides it for testing. Every `requests.jsonl` line carries the `pid` of the `ccc` process that wrote it, which tells apart concurrent sessions sharing the log. The same rule holds inside a tool loop, so a long single turn (a headless `-p` run, or a long agentic loop) is compacted as it grows rather than only when you next type: each tool request under the budget goes out with no compression call, the one that reaches it is compressed once and becomes the stable prefix, and later tool requests and your next message ride that prefix until it reaches the budget again. `requests.jsonl` shows the `compaction` of each main-thread human turn and of every tool turn (budget, its source, the size estimate, and the reason for a compaction: `budget`, `prefix-mismatch`, `manual` or `target-change`); a human turn sent on the stable prefix is `turnType: "followup-prefix"`, a tool turn `tool-memory` (on its route) or `tool-prefix` (on the prefix directly), and a tool turn that compacted `tool-recompressed`.

That compressed context stays in force for the rest of the turn: the tool loop it kicks off, and the matching Count Tokens calls, are routed through the same compressed prefix. The Count Tokens part matters — Claude Code sizes its context from those replies, so counting the uncompressed history would make it auto-compact a conversation memory had already shrunk. A mismatched or resumed conversation shape drops the route rather than grafting one session's prefix onto another.

Compressed prefixes are stored per *lane*, not in a single slot: the main thread, each subagent, and the away-summary side channel each key their own route by session and identity. Every lane gets the same deal — it installs its own prefix and rides it — and lanes cannot evict one another, so a subagent or a background side request can no longer strand the main conversation on full history.

Programs you run from inside a `ccc` session (scripts, test suites, SDK apps) inherit its `ANTHROPIC_BASE_URL`, so their Anthropic calls reach `ccc` too. `ccc` handles only Claude Code's own requests, which always carry an `X-Claude-Code-Session-Id` header. Anything else is forwarded to Anthropic unchanged: it is never compressed or indexed on MemTree, and it cannot disturb the session's compressed history. These requests are logged in `requests.jsonl` as `turnType: "foreign"` with the start of their `User-Agent`. `CCC_CLAUDE_CODE_ONLY=0` turns the filter off.

Subagents follow the same budget rule in their own tool loops: under the budget a subagent's tool request goes out as it is, and the one that reaches it is compressed once and becomes that subagent's route, which its later tool requests ride. A tool-turn compression is a blocking MemTree call and a soft fuse, not a hard cap: if MemTree is unavailable or returns nothing usable within its normal compression budget, the request goes out on the old prefix, or whole when there is none; a failed call puts compression on a brief cooldown, so an outage costs one stall rather than one per tool call, and a lane whose attempt produced nothing waits until its history has grown by a twentieth of the budget before trying again. An attempt that finds nothing indexed yet (a no-op with no tree) makes the lane skip compression calls until MemTree reports that tree built; a request that would overflow the context window still tries. A request with no session id is compressed without installing, since a route that cannot be matched later must not be stored. `/memtree-compact off` and `CCC_COMPACT_TARGET=off` pass tool requests through with no compression call. `CCC_TOOL_ROUTE_RECOVERY=0` turns off tool-turn compression for one invocation (tool requests make no size check and no compression call; human turns still compact); outcomes are recorded in `~/.claude-code-infinite/logs/requests.jsonl` under `routeLane`/`routeMiss`/`routeRecovery` (`compressed`, `noop`, `failed`, `no-gain`, `cooldown`, `in-flight`, `backoff`, `awaiting-index`, `disabled`, ...).

Routing decisions, per-turn timings and usage, recovery outcomes, and delivery status are recorded in `~/.claude-code-infinite/logs/requests.jsonl`.

The compression budget is a trigger to try MemTree, not a hard forwarding limit.
If compression is unavailable, `ccc` sends the available request when its input
plus output reservation fits the model's native window. If Count Tokens fails or
is disabled, a learned estimate alone cannot block the turn: the final check uses
the plain bytes-based estimate. Such a fallback can still be rejected by the
upstream API, which makes the final tokenization decision. An `overBudgetForward`
field in the request log marks requests forwarded above the compression budget.

Sizing belongs to the individual request. Original bodies, validated compressed
prefixes, and replacement bodies each retain their own estimate and count result;
the compression planner, `client_input_tokens`, and final selection consult that
shared record. A fitting compressed candidate is preferred, with the original as
a fallback. If counting is unavailable, candidate selection uses the conservative
bytes-based input estimate plus the requested output reservation against the
model's native window. Refusal requires that no eligible candidate fits; a failed
replacement cannot discard an original or prefix that still fits.

`ccc` uses Anthropic Count Tokens selectively to check uncertain sizes and before
refusing an estimated overflow. Counts describe the particular body being sent,
including a compressed body when applicable. A request shares a three-second
counting allowance across its checks; authentication failures and rate limits
put counting on a bounded cooldown. `CCC_COUNT_TOKENS=0` disables these checks.
The `countTokens` array in each request-log record lists the status class and
elapsed milliseconds of each actual attempt, without bodies or credentials.
If counting an assembled compressed prefix discovers that it is over budget,
`ccc` makes at most one bounded recovery compression attempt before deciding
whether to forward or refuse it. The request log records that decision under
`lateCountRecovery.outcome` as `compressed`, `forwarded`, or `refused`.

Before publishing a release, verify Claude subscription OAuth counting in a live
session: launch this checkout's `node dist/cli.js --resume` with the normal Claude
subscription login and resume a large conversation. After sending a turn, inspect
the new `countTokens` entries in the request log for that process's `pid`. A
successful count confirms acceptance; an authentication failure should leave the
turn on the bytes-based fallback and suppress further counts during cooldown.
An absent entry means no count was needed, so that turn does not verify OAuth
acceptance. Mock tests verify header forwarding and failure behavior; they do not
establish that Anthropic accepts subscription OAuth for this endpoint.

Memory quality is evaluated offline: the weekly `memtree-bench` harness replays a fixed scenario through a ccc-wrapped arm and a vanilla Claude Code arm and grades complete outcomes blind against an answer key. (An earlier in-request memory-vs-full A/B comparison with a live grader was removed in 2026-08; it was off by default, and the offline benchmark measures the same question with a stronger instrument.)

## More than a memory-retrieval tool

Search tools alone don't keep a long session's context from growing until the model degrades.
Claude Code Infinite does both: it indexes and searches your history, and it manages what the model
sees, keeping it within budget. It works alongside your MCP servers, tools and other Claude Code
features, and their output, often the biggest source of tokens, is exactly what MemTree reduces most.

## Usage Tips

* If you want your session to apply to many different tasks, we recommend giving the overall high level goal you want for your session in the first message, e.g. "Refactor this project to remove code smells and bugs". Then followup with lower level tasks in subsequent messages.  This as Anthropic models key heavily off the first message. You should also feel free to start new sessions for new tasks. This as the model will continue to have a focused context with your CLAUDE.md and first message always included. Reach out to support@polychat.co if you have any questions or concerns!

* Add context to your status line to see how MemTree keeps your context small
  ```bash
  /statusline add context % used
  ```
* You want your fresh session context to be **10k** tokens or less. If your starting context is more than that, consider reducing the size of your custom MCP's and slash commands to ensure Claude performs at its very best

* You can resume previous threads with `/resume`

For `ccc --resume <id>`, an automatic, best-effort repair can unblock a transcript whose last response already exceeds Claude Code’s local refusal limit. It changes only that response’s usage totals and the iteration Claude Code counts, after writing an exclusive, uniquely named backup under `~/.claude-code-infinite/transcript-backups`. Earlier iterations and conversation content stay intact. The installed Claude Code 2.1.288 computes its blocking limit as the context window minus the output allowance (capped at 20,000) minus 3,000 tokens: 977,000 for the supported 1M models. Other versions use the conservative full-window threshold. The window comes from ccc’s model table, explicit `[1m]` transcript model signals, and any `--model` or `ANTHROPIC_MODEL` override, conservatively keeping the largest supported window. A successful response with input already beyond that inferred window disproves the inference and is never repaired. Unknown model overrides (including unresolved aliases), models or usage shapes, threshold overrides, possible running writers, changed snapshots, backup collisions, and filesystem errors all skip repair and continue the original resume. Process and file checks are bounded; other running JavaScript runtimes may conservatively prevent repair.


## Troubleshooting

### Anthropic auth errors (401s, login prompts)

`ccc` never touches your Anthropic credentials — Claude Code manages its own login exactly as it does without `ccc`. If you see auth errors, fix them the vanilla way: run `/login` inside Claude Code (or `claude` directly) and re-authenticate.

### MemTree degraded / passthrough mode

If you see an inline "⚠ MemTree degraded — this turn ran uncompressed" notice, the compression API is unreachable or your MemTree key is invalid/expired. Your session keeps working uncompressed. Check your key at [polychat.co](https://polychat.co/auth?memtree=true), or delete it from `~/.claude-code-infinite/config.json` and re-run `ccc` to re-enter it.

## Upgrading

`ccc` checks npm at startup (bounded to two seconds, silent if offline) and, when a
newer release exists, shows one line under the MemTree banner inside Claude Code with
the upgrade command. Upgrading is never automatic:

```bash
npm install -g claude-code-infinite
```

(While the npm package is behind — see Install above — upgrade with the GitHub tarball
command instead.)

Set `CCC_SKIP_UPDATE_CHECK=1` to disable the check (air-gapped or CI runs).
