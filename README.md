<p align="center">
  <img width="470" height="214" alt="cc-inf-wide-transparent" src="https://github.com/user-attachments/assets/1524e5dc-637f-4d25-9a15-f7f7b65c8182" />
</p>

# Claude Code Infinite

<p align="center">
  <a href="#long-session-benchmark"><img width="640" alt="Long-session benchmark, Claude Opus 5.5, graded blind: MemTree 69% at 39M tokens per run, full context 69% at 113M, /compact 49% at 17M" src="https://raw.githubusercontent.com/crizCraig/claude-code-infinite/main/docs/images/benchmark-chart.png"></a>
</p>
<p align="center"><sub>Long-session benchmark on a 775k-token Claude Code session (Claude Opus 5.5, graded blind):
MemTree matched full context at 69% with a third of the tokens; <code>/compact</code> scored 49%.
<a href="#long-session-benchmark">Full results</a></sub></p>

Infinite context for Claude Code: memory for long-running agents. Claude Code Infinite indexes your Claude Code sessions with
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
* **Never loses anything vs Claude Code.** Sessions are sent word for word until near the context
  limit; past it, MemTree matched full context (69 vs 69) and beat `/compact` by 20 ([benchmark](#long-session-benchmark))
* **Unlimited-length sessions**, with relevant past information recalled automatically
* **A local proxy, so no slowdown.** Requests go straight from your machine to Anthropic and
  MemTree indexes in the background; only the occasional compression step, when a session
  outgrows the context budget, waits on MemTree

The magic starts past the context limit. Keep one session going for days and it learns how you
work: your priorities, the nuances of your projects, your company and your environment. Where
`/compact` would wipe that detail, MemTree keeps it, so the thread becomes an expert in you. Let it
orchestrate dozens of subagents on your behalf.

> [!IMPORTANT]
> Needs [Claude Code in your terminal](#setup), signed in with Claude Pro or Max.

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

* **[Claude Code in your terminal](https://code.claude.com/docs/en/quickstart), signed in
  with Claude Pro or Max** ([don't have it yet?](#setup))
* [node.js 20.3 or newer](https://nodejs.org/en/download/)

<sub>Also works with an Anthropic API key that has credit, but that's far costlier than Pro or Max.</sub>

## Setup

1. Install Claude Code Infinite (Node ≥ 20.3; no git needed)
  ```bash
  npm install -g claude-code-infinite
  ```
2. Run it from your project folder
  ```bash
  ccc
  ```

This will guide you through setting up your PolyChat key which you can also get [here](https://polychat.co/auth?memtree=true).

Needs [Claude Code in your terminal](https://code.claude.com/docs/en/quickstart), signed in with
Claude Pro or Max.

<details>
<summary>Don't have Claude Code yet?</summary>

```powershell
# Windows PowerShell
irm https://claude.ai/install.ps1 | iex
```
```bash
# macOS / Linux
curl -fsSL https://claude.ai/install.sh | bash
```

Or just run `ccc`: when Claude Code isn't installed it offers to install it for you (with the
same official command) and starts it, and Claude Code asks you to sign in. The Claude desktop
app isn't enough: `ccc` needs the `claude` command in your terminal
([help](#claude-code-isnt-installed)).

</details>

## Environments

The tool supports multiple environments (this selects the MemTree compression API only — Anthropic traffic always goes directly from your machine to api.anthropic.com):

- **Production** (default): `ccc` - Uses https://api.polychat.co
- **Local**: `ccc local` - Uses http://localhost:8080 for local development

Each environment maintains its own separate API key.

## Commands

Type these inside a `ccc` session (the `ccc:` prefix is optional). `ccc` answers them
locally, so they cost no model turn.

| Command | What it does |
| --- | --- |
| `/ccc:memtree` | Lists the MemTree commands and links your usage dashboard. |
| `/ccc:memtree-view` | Shows the link to this session's MemTree page. |
| `/ccc:memtree-compact [tokens]` | Compacts the session on your next message (to half the budget, or a target such as `400k`) and keeps the compressed history. |
| `/ccc:memtree-compact off` | Goes back to sending the conversation whole. |

From a shell or script (no session needed):

| Command | What it does |
| --- | --- |
| `ccc link <session-id>` | Prints the session's newest MemTree page URL on stdout, one line and nothing else. `--json` prints `{session_id, url, tree, updated_at}` instead (`updated_at` is the session's last activity). Exit status 0 printed, 1 no saved key or the server could not be reached (5 s timeout), 2 bad invocation, 3 the session has no MemTree yet (or no session with that id on your key; stderr says which). Only your own sessions (those of your saved key) are found. `ccc staging link` / `ccc local link` use that environment's key. |
| `ccc fetch <memtree-url>` | Prints one of your MemTree pages as JSON, using your saved key. |

Environment variables, set when launching `ccc`:

| Variable | What it does |
| --- | --- |
| `CCC_COMPACT_TARGET=500k` | Compaction target for every session (useful for headless `-p` runs); `off` starts every session with compaction off. |
| `CCC_MEMTREE_MCP=0` | Turns off the `memtree` MCP tools ([details](#memory-tools)), in interactive and headless (`-p`) runs. |
| `CCC_PROJECT_TREES=0` | Interactive sessions in a git repository with an `origin` remote start with a short list of your earlier MemTree sessions in that repository (model context only); this turns it off. |
| `CCC_MEMTREE_LINK` | Where the MemTree link appears: `turn` (default, end of a turn with a new page), `message` (under every reply), `stop` (end of every turn), `success` (only after an optimized turn), or `off`. |
| `CCC_AUTO_COMPACT=1` | Restores Claude Code's own auto-compaction and idle compaction settings ([details](#claude-code-auto-compaction)). |
| `CCC_NO_UPDATE_CHECK=1` | Turns off the update check, and with it automatic updates ([details](#upgrading)). |
| `CCC_DISABLE_AUTOUPDATE=1` | Keeps the update notice but never installs ([details](#automatic-updates)). |
| `CCC_NO_DIAGNOSTICS=1` | Turns off diagnostics ([details](#diagnostics)). So do `DO_NOT_TRACK=1`, Claude Code's `DISABLE_TELEMETRY=1` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, and `"diagnostics": false` in `~/.claude-code-infinite/config.json`. |

Links are clickable in terminals that support OSC 8 hyperlinks (iTerm2, Ghostty, WezTerm,
kitty, VS Code, JetBrains, Windows Terminal); elsewhere you get the plain URL.

## Claude Code auto-compaction

`ccc` disables Claude Code's automatic conversation compaction for the Claude process it launches. MemTree manages the context sent to the model, so letting Claude Code independently summarize the full local transcript can compact a conversation MemTree already reduced. Manual `/compact` remains available.

That includes idle compaction (Claude Code 2.1.286 and later), which summarizes a
long conversation while you're away, just before the prompt cache expires
("Compacted while idle, before the prompt cache expired"). The
`DISABLE_AUTO_COMPACT=1` that `ccc` sets turns it off too, so you don't need
`"idleCompaction": false` in your settings.

Claude Code 2.1.219 also recommends “Resume from summary” for any old session
above a fixed 100k-token threshold, even when the active model has a 1M window
and auto-compaction is disabled. `ccc` suppresses that resume-time
recommendation as well; it does not disable the manual `/compact` command.

With auto-compaction off, Claude Code still refuses a request itself, without
sending it, once its own estimate reaches the window minus 23k (977k on a 1M
window). MemTree compresses at 900k, so a single large tool round could reach that
refusal before `ccc` ever saw the request. `ccc` sets
`CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` (unless you exported your own) so such a
request reaches the proxy, which compresses it mid-turn.

A session whose last response reached the verified local refusal threshold
(for example one sent whole while MemTree was unavailable) would otherwise be
refused locally with "Context limit reached" on every prompt after a resume.
On `ccc --resume <id>`, `ccc` backs the transcript up to
`~/.claude-code-infinite/transcript-backups/` and lowers that last response's
recorded usage to half the window, so the next message is sent and MemTree
compresses it.

To restore Claude Code's native auto-compaction and idle compaction settings for one
invocation, use:

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
- If MemTree is unreachable, slow, or your MemTree plan needs payment, `ccc` degrades to a transparent passthrough so your session is never interrupted. While MemTree is paused (usage limit reached), a request that still fits the model's context window (by Anthropic's token count, or ccc's conservative estimate when counting is unavailable) goes out unchanged, as plain Claude Code would send it, and once the session reaches the compression budget the paused notice suggests Claude Code's own `/compact` while it still fits. A request that no longer fits is refused at once with "MemTree is paused (usage limit reached), so this long conversation can't be compressed…", your subscribe link, and `/clear` to start fresh (`/memtree-compact` needs MemTree, so it is not offered then). After you subscribe, the next request compresses again with no restart.

### Diagnostics

`ccc` sends a few diagnostics to MemTree so we can see why a session fails to start or stalls:

- versions (ccc, Claude Code, Node), how ccc was installed (npm, npx, linked), OS and CPU
  architecture, terminal type and locale;
- how Claude Code is signed in, as a type only (Claude.ai subscription, API key, Bedrock,
  Vertex, Foundry), the plan's tier name when Claude Code records one (Pro, Max, Team), the main
  model's context window ccc uses (200k or 1M), and where Claude Code was found (on PATH,
  its installer's folder, npm, winget);
- lifecycle events (first run, sign-in prompt shown, key accepted or rejected, session start,
  the MemTree-paused notice shown, update hint or background update result);
- errors as codes, status numbers, sizes and timings (an Anthropic 401, a MemTree 402, a
  compression timeout).

Never sent: your prompts or any conversation content, file paths, project or repository names,
hostnames, usernames, environment values, keys or tokens, or error message text. Each event is
checked against a fixed allowlist on your machine before it is queued, and again by the server.
They are tied to your MemTree key when you have one, otherwise to a random install id in
`~/.claude-code-infinite/install_id`. Sending is batched in the background and never slows a
request; a failed send is dropped.

Turn diagnostics off with any of: `CCC_NO_DIAGNOSTICS=1`, `"diagnostics": false` in
`~/.claude-code-infinite/config.json`, `DO_NOT_TRACK=1`, or Claude Code's own
`DISABLE_TELEMETRY=1` / `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.

### Memory tools

Every `ccc` session, interactive or headless (`-p` and non-TTY runs), gets a small MCP server, `memtree`, with four read-only tools (see [Search across sessions](#search-across-sessions)): `mcp__memtree__search` (`query`; optional `tree`, `"current"` for this session or omitted for all of your sessions; `mode` `text` (default, free) or `vector` (meaning, first page charged); `project`, `since`, `until`, `cursor`, `limit` (default 10, at most 50)), `mcp__memtree__read_node` (`node`, an address `<tree>#<id>` from search, or `id` with optional `tree`: summary, path from the root, children, leaf line range), `mcp__memtree__read_lines` (a leaf's `node`, or `block`, `start`, `end` with optional `tree`: exact transcript lines, at most 400 lines / 40k characters per call) (with `tail: true` instead, the newest messages after the tree that are not indexed yet) and `mcp__memtree__list` (your sessions, most recently active first; `since`, `until`, `project`, `q`, `cursor`, `limit`). Other sessions' trees are named explicitly by reference and authorized by your MemTree key. This session's tree (`tree: "current"`, or no `tree` on `read_node`/`read_lines`) is the one the current request was served from: the server asks the `ccc` proxy for `GET $ANTHROPIC_BASE_URL/memtree/current?session=<id>` (only that session's compression source page, or its stored source page on resume; `current.json?session=<id>` returns the page itself). Completed pages are cached. If the proxy temporarily serves an older prefix while a newer tree is indexing, the tools reuse that prefix during a 45-second cooldown, then check the page again. `ccc` registers it with `--mcp-config=<temp file>`, which keeps working under `--strict-mcp-config`, and pre-allows the four read-only tools; `CCC_MEMTREE_MCP=0` turns it off. The MCP process requires `CLAUDE_CODE_SESSION_ID` and checks that both the pointer and page belong to it. If Claude Code retains an MCP process with an old session ID after `/clear` or a session switch, reconnect the MCP server with the current session ID; it cannot infer a new identity from another session using the proxy. Your own choices win: if your `--mcp-config` already names a server `memtree`, `ccc` adds and pre-allows nothing (if it runs `ccc memtree-mcp`, or `ccc staging memtree-mcp`, the tools work as usual); `--allowedTools` lists are added together, so yours is kept and only the four memtree tools are pre-allowed; tools named by `--disallowedTools` (one tool, `mcp__memtree`, or `mcp__memtree__*`) are neither pre-allowed nor advertised. With `--continue`, Claude Code starts MCP servers under a new session id before it switches to the continued session, so this session's tree fails closed (`list` and searches across sessions still work); use `--resume <id>` instead. Whenever the tools are configured, compress calls carry `x-memtree-tools: search,read_node,read_lines,list` so MemTree tells the model how to use them.

### Headless / agents

`ccc -p` works like `claude -p`, so an agent or orchestrator can drive it. Keep one Claude Code session per long-lived agent and resume it on every call, so MemTree keeps compacting and indexing one growing conversation:

```bash
ccc -p --resume <session-id> --output-format json "…"
```

Start the session with `ccc -p --session-id <uuid> "…"` (or take `session_id` from the first JSON result). Never run two `ccc` processes on one session at the same time: both would append to the same transcript. Headless runs have the [memory tools](#memory-tools) with no extra flags (`CCC_MEMTREE_MCP=0` turns them off; they can read all of the sessions your MemTree key owns, so give each user of a shared agent platform their own key). Stdout carries only Claude Code's output, so `--output-format json` and `stream-json` parse as with `claude`; `ccc`'s own lines (banner, mode, request log path) go to stderr. `--mcp-config` takes several values, so pass your own as `--mcp-config=<file>` or put the prompt before it; otherwise it swallows a prompt that follows it.

To show an agent's memory after a run, `ccc link "$sid"` prints the session's newest MemTree page URL (exit 3 when it has no tree yet). It can trail the run by one call: a `-p` run's newest tree is built as it exits.

The full guide for agent platforms (setup, output parsing, memory tools, tree links, older versions) is [docs/headless.md](docs/headless.md).

## How it works

<table><tr><td>
<img width="1050" height="445" alt="image" src="https://github.com/user-attachments/assets/d1ab2456-9a64-4118-a72a-b9d133c7c8bd" />
</td></tr></table>


When you send a message, we retrieve relevant details and summaries from the prior messages in your thread. These details and summaries populate a **memory message**. Following the memory message, we append a compressed version of your recent message history. The resulting context-window is dramatically smaller, allowing Claude to process your request with much greater efficacy, lower latency, and reduced cost.

**Compaction keeps a stable prefix.** While a conversation fits the model's budget (900k tokens for Opus 5.5, where plain Claude Code would auto-compact at 967k), it is sent whole. When a request reaches the budget, `ccc` compresses it once, to half the budget (or your `/memtree-compact N`), and keeps those compressed bytes as the session's prefix. Every later request, human turns included, is that same prefix followed by the messages that came after it, verbatim, with no compression call (MemTree still indexes in the background). Because the prefix does not change, Anthropic reads it from the prompt cache on every turn after the one that compacted, instead of writing the whole compressed context again. `ccc` compresses again only when prefix plus newer turns reach the budget (measured from the size Anthropic reported for the previous request, plus an estimate for what was added), or when the messages the prefix stands for change (rewind, edit, fork, `/clear`). If that recompression fails, the turn is sent on the old prefix rather than the whole history. The prefix is also kept on disk, one file per session under `~/.claude-code-infinite/stable-prefixes/` (mode 600 in a private directory, at most 64 sessions and 256 MB, oldest dropped first), so the first turn after `ccc --resume` rides it instead of waiting on a fresh compression. A stored prefix belongs to the MemTree backend and key that wrote it (identified by a hash, never the key itself) and is never used with another. It is used only if the resumed history still matches what it replaced; a main-thread history that no longer matches discards it, while side requests (such as Claude Code's web-search helper) leave it alone. Only the main thread's prefix is stored, never a subagent's. The budget is the one MemTree reports for the model; until the server reports one, `ccc` uses 90% of the context window for every Claude model, but no later than plain Claude Code would auto-compact (167k of a 200k window; at most 400k for Sonnet 4.x and 550k for Sonnet 5 / 5.5, which degrade before their window), and 80% for other models. `CCC_BUDGET_TOKENS=60k` overrides it for testing. Every `requests.jsonl` line carries the `pid` of the `ccc` process that wrote it, which tells apart concurrent sessions sharing the log. The same rule holds inside a tool loop, so a long single turn (a headless `-p` run, or a long agentic loop) is compacted as it grows rather than only when you next type: each tool request under the budget goes out with no compression call, the one that reaches it is compressed once and becomes the stable prefix, and later tool requests and your next message ride that prefix until it reaches the budget again. `requests.jsonl` shows the `compaction` of each main-thread human turn and of every tool turn (budget, its source, the size estimate, and the reason for a compaction: `budget`, `prefix-mismatch`, `manual` or `target-change`); a human turn sent on the stable prefix is `turnType: "followup-prefix"`, a tool turn `tool-memory` (on its route) or `tool-prefix` (on the prefix directly), and a tool turn that compacted `tool-recompressed`.

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

A blocking compression call normally gets 15 seconds; when it fails, the request
goes out on the old prefix or whole. When there is neither (no compressed prefix
to ride, as on the first turn after `--resume`, and a whole request that delivery
would refuse as over the window), the call gets 120 seconds instead, since a timeout
could only end in a refusal. `CCC_COMPRESS_TIMEOUT_MS` overrides both. A Claude
Code retry that arrives while the same session's compression of the same history
is running waits for that call instead of starting another.

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


## Releasing

Releases are published by GitHub Actions through npm Trusted Publishing (OIDC): no npm
token, passkey or staging step. Each one waits for approval of the `npm` GitHub environment
(reviewer: crizCraig). That approval is a GitHub permission: anything holding a maintainer's
GitHub token with `repo` scope (including an agent using `gh`) can grant it, so keep such
tokens out of untrusted sessions.

1. [release-please](https://github.com/googleapis/release-please) keeps a **Release x.y.z**
   pull request open on `main` ([`.github/workflows/release.yml`](.github/workflows/release.yml)).
   It bumps `package.json`, `package-lock.json` and `.release-please-manifest.json` and adds
   a `CHANGELOG.md` entry, and it updates itself on every push to `main`.
2. Merge it when you want to release. release-please then tags `vX.Y.Z`, creates the GitHub
   release and starts [`.github/workflows/publish.yml`](.github/workflows/publish.yml) on the
   tag. That checks that the tagged commit is on `main` and that the tag equals
   `package.json`'s version, runs the full CI matrix (`ci.yml`), and checks that the committed
   `dist/` matches a fresh build.
3. Approve the `npm` environment (one tap in the GitHub mobile app, or **Review deployments**
   on the run). The job then runs `npm publish --provenance --access public`.

Commits: release-please only opens the PR, and only lists a commit in the changelog, for
conventional prefixes: `feat:`, `fix:`, `perf:`, `refactor:`, `revert:` or `deps:` (a scope
is fine, e.g. `fix(exit): ...`). Other subjects such as `Exit: ...` or `README: ...` are
allowed and ship in the release, but are not listed. Every release is a patch bump. For a
minor or major release, or to release with no listed commit, push an empty commit:

```bash
git commit --allow-empty -m "chore: release 1.1.0" -m "Release-As: 1.1.0"
```

The trusted publisher on npmjs.com is bound to the workflow file `publish.yml` and the GitHub
environment `npm`; renaming either breaks publishing. `./publish.sh --local [patch|minor|major]`
is the emergency path: from a `main` that matches `origin/main`, it publishes directly from
your machine with npm web auth, then pushes the release commit (including the release-please
manifest) and the tag in one atomic push, and creates the GitHub release.
publish.yml still tests that tag but skips publishing, since the version is already on npm.

## Troubleshooting

### Anthropic auth errors (401s, login prompts)

`ccc` never touches your Anthropic credentials — Claude Code manages its own login exactly as it does without `ccc`. If you see auth errors, fix them the vanilla way: run `/login` inside Claude Code (or `claude` directly) and re-authenticate.

### "Claude Code isn't installed"

`ccc` runs Claude Code, so it has to be installed and signed in first. `ccc` finds it on
PATH and, failing that, where its installers put it (`%USERPROFILE%\.local\bin`,
`%APPDATA%\npm`, winget's folder and your saved user PATH on Windows; `~/.local/bin`,
`~/.claude/local` and Homebrew elsewhere), so a terminal opened before the install works
too. If it is not there, `ccc` asks "Claude Code isn't installed. Install it now? [Y/n]"
(also when only the Claude desktop app is installed). Yes runs Anthropic's official installer
(Windows PowerShell: `irm https://claude.ai/install.ps1 | iex`; macOS/Linux:
`curl -fsSL https://claude.ai/install.sh | bash`) with its output on screen, then carries on
in the same terminal (on a first run, after your MemTree key) into Claude Code, which asks you
to sign in. `ccc` never installs anything
without that yes, and without a terminal (`ccc -p`, a pipe) it only prints those commands.
To install it yourself: run the command, open a new terminal, run `claude` once to sign in,
then run `ccc` again, from your project folder.

### "You've hit your Claude plan's usage limit" / "Anthropic is busy"

When Anthropic answers a turn with 429 or 529, `ccc` tells the two apart the way Claude Code
does. Your Claude plan's usage limit (a 429 its limiter rejected) gets "You've hit your Claude
plan's usage limit. It resets at <time>." (your local time, when Anthropic says) on your next
prompt and as `ccc` exits. Anything else (529 overloaded, another 429) is Anthropic being busy:
Claude Code retries it itself, and if it still failed you get "Anthropic was busy; try again in
a moment." on your next prompt or as `ccc` exits. The response itself reaches Claude Code
unchanged, so its own retries and messages work as they do without `ccc`. In a print run
(`ccc -p`) the line goes to stderr right away (for busy: "Anthropic is busy; Claude Code will
retry.").

### "Credit balance too low"

`ccc` isn't free Claude: it runs your own Claude Code with your own Anthropic login. When
Anthropic answers "credit balance too low", Claude Code is billing an API key, an
Anthropic Console account (API usage billing) or a Claude account without a paid plan, and
that balance is empty. `ccc` says so as it exits, and again before the first prompt of the
next launch until a request goes through. Sign in with a Claude Pro or Max plan: run
`claude`, `/logout`, then `/login` and choose "Claude account with subscription" (not
"Anthropic Console account"). Or add credit.

`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and an `apiKeyHelper` setting beat `/login`:
with one of them set, Claude Code bills that key even when you're signed in with a plan.
`ccc` prints a line before Claude Code starts when that happens; unset it to use your plan.

### MemTree degraded / passthrough mode

If you see an inline "⚠ MemTree degraded — this turn ran uncompressed" notice, the turn needed compression (over its budget, an explicit `/memtree-compact`, or a size ccc could not confirm fits) but the compression API could not be reached or answered too slowly, so the turn went out whole. Your session keeps working uncompressed. A turn still under the budget needs no compression, so a MemTree failure on it shows no notice (it is recorded in `~/.claude-code-infinite/logs/requests.jsonl`). Check your key at [polychat.co](https://polychat.co/auth?memtree=true), or delete it from `~/.claude-code-infinite/config.json` and re-run `ccc` to re-enter it.

## Upgrading

`ccc` checks npm at startup (bounded to 1.5 seconds, silent if offline, and cached for a
day in `~/.claude-code-infinite/update-check.json`). Prereleases are never offered, and
print (`-p`) or non-TTY runs skip the check. When a newer release exists and `ccc` can
update itself, it does (see [Automatic updates](#automatic-updates)); otherwise it shows
one line under the MemTree banner inside Claude Code, e.g.
`• ccc 1.0.21 is available (you have 1.0.20) · npm i -g claude-code-infinite@latest`.
To upgrade by hand:

```bash
npm i -g claude-code-infinite@latest
```

Set `CCC_NO_UPDATE_CHECK=1` (or the older `CCC_SKIP_UPDATE_CHECK=1`), or add
`"updateCheck": false` to `~/.claude-code-infinite/config.json`, to disable the check
(air-gapped or CI runs). That also turns off automatic updates.

## Automatic updates

Like Claude Code, `ccc` installs a newer release for you in the background. A few
seconds after an interactive session starts, if the update check found a newer
release, `ccc` runs

```bash
npm install --global --prefix=<your npm prefix> claude-code-infinite@<that version> --no-fund --no-audit
```

in a detached process, so the session never waits for it and quitting `ccc` does not
stop it. When it has finished, the next session start inside Claude Code (a new
conversation, `/clear`, or a resume) shows, once:

```
✔ ccc 1.0.21 installed · restart ccc to use it
```

The session keeps running the version it started with until you restart `ccc`. If the
install fails, you get the usual `• ccc 1.0.21 is available … · npm i -g
claude-code-infinite@latest` line instead, and `ccc` waits a day before trying again; it
tries each version at most twice. The npm output of the last attempt is in
`~/.claude-code-infinite/auto-update.log`, and its result in `update-state.json` next to
it. Only one session installs at a time (`update.lock.d` there). If an installer was
killed in a way `ccc` cannot verify, that lock stays held rather than risk two installs
at once; after an hour `ccc` shows the update line instead, and deleting
`~/.claude-code-infinite/update.lock.d` clears it.

**When it doesn't.** `ccc` updates itself only when it is a plain global npm install
(`npm i -g`) whose files are in `npm root -g` and writable by you. It never uses `sudo`.
In every other case it only shows the update line, with the command that fits the install:

- `npm link`ed or git checkouts: a development copy is never touched, and the line says to
  `git pull && npm run build` in a git checkout, or to update and rebuild the linked folder
  otherwise (`npm i -g` would replace the link with the published package),
- `npx` and project-local installs,
- pnpm, yarn, bun and Volta global installs (the line gives your tool's own command),
- a global prefix that needs `sudo` to write, or `ccc` running as root,
- print (`-p`) and non-TTY runs, which never install anything.

**Windows.** The install starts as `ccc` exits rather than during the session: the
background installer waits for that `ccc` to be gone before npm runs, so npm does not
rewrite files under the session that started it. The banner says so (`• ccc X is
available … · installs when you exit ccc`). A `ccc` started while it installs says
"Finishing a ccc update…" and waits for it (usually seconds, at most two minutes), then runs the new
version. Closing the terminal window usually counts as exiting too. By hand:
`npm i -g claude-code-infinite@latest`.

`ccc --debug` prints which install method was detected and what it decided.

**Sessions running during an update.** npm replaces `ccc`'s files while other `ccc`
sessions may be running. They are unaffected: each `ccc` loads all of its code when it
starts, and the Claude Code hooks it registers either call into that running `ccc` over
localhost or run files in its own temporary plugin directory, never the installed
package. The one exception is the `memtree` MCP server, which Claude Code starts from the
installed files: a server started after the update (for example, Claude Code restarting
it with `/mcp`) runs the new version against the old session. It keeps working, and if a
tool call fails it says that the versions differ and to restart `ccc`. If Claude Code
starts it in the few seconds while npm is writing the files, it can fail to start; `/mcp`
reconnects it.

**Turning it off.** Any of these keeps the update line but never installs:

- `CCC_DISABLE_AUTOUPDATE=1`,
- `"autoUpdate": false` in `~/.claude-code-infinite/config.json`,
- Claude Code's own `DISABLE_AUTOUPDATER=1`.

The update-check opt-outs above turn off both the check and automatic updates.
