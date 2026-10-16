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
* **Replaces `/compact` without losing the thread.** MemTree beats `/compact` by 20 points in our
  long-context benchmark ([details](#long-session-benchmark))
* **Nothing is compressed early.** Claude sees every message word for word, just as in plain
  Claude Code, until a session reaches about 800k tokens (80% of the 1M context window on
  current models). Only then does MemTree step in, in place of Claude Code's auto-compact, which
  loses detail
* **Unlimited-length sessions**, with relevant past information recalled automatically
* **A local proxy, so no slowdown.** Requests go straight from your machine to Anthropic and
  MemTree indexes in the background; only the occasional compression step, when a session
  outgrows the context budget, waits on MemTree

> [!IMPORTANT]
> Requires a Claude Pro or Max subscription.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/crizCraig/claude-code-infinite/main/docs/images/benchmark-dark.svg">
    <img width="600" alt="Long-session benchmark, judged score out of 100: Claude Code Infinite 69, full context 69, /compact 49" src="https://raw.githubusercontent.com/crizCraig/claude-code-infinite/main/docs/images/benchmark-light.svg">
  </picture>
</p>

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
* **A Claude Pro or Max subscription**

<sub>Also works with an Anthropic API key, but that's far costlier than Pro or Max.</sub>

## Setup

1. Install (Node ≥ 20.3; no git needed)
  ```bash
  npm install -g claude-code-infinite
  ```
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

## Commands

Type these inside a `ccc` session (the `ccc:` prefix is optional). `ccc` answers them
locally, so they cost no model turn.

| Command | What it does |
| --- | --- |
| `/ccc:memtree` | Lists the MemTree commands and links your usage dashboard. |
| `/ccc:memtree-view` | Shows the link to this session's MemTree page. |
| `/ccc:memtree-compact [tokens]` | Compacts the session on your next message (to half the budget, or a target such as `400k`) and keeps the compressed history. |
| `/ccc:memtree-compact off` | Goes back to sending the conversation whole. |

Environment variables, set when launching `ccc`:

| Variable | What it does |
| --- | --- |
| `CCC_COMPACT_TARGET=500k` | Compaction target for every session (useful for headless `-p` runs); `off` starts every session with compaction off. |
| `CCC_MEMTREE_LINK` | Where the MemTree link appears: `turn` (default, end of a turn with a new page), `message` (under every reply), `stop` (end of every turn), `success` (only after an optimized turn), or `off`. |
| `CCC_AUTO_COMPACT=1` | Restores Claude Code's own auto-compaction setting ([details](#claude-code-auto-compaction)). |
| `CCC_NO_UPDATE_CHECK=1` | Turns off the update check, and with it automatic updates ([details](#upgrading)). |
| `CCC_DISABLE_AUTOUPDATE=1` | Keeps the update notice but never installs ([details](#automatic-updates)). |

Links are clickable in terminals that support OSC 8 hyperlinks (iTerm2, Ghostty, WezTerm,
kitty, VS Code, JetBrains, Windows Terminal); elsewhere you get the plain URL.

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

### Memory tools

Interactive `ccc` sessions also get a small MCP server, `memtree`, with four read-only tools (see [Search across sessions](#search-across-sessions)): `mcp__memtree__search` (`query`; optional `tree`, `"current"` for this session or omitted for all of your sessions; `mode` `text` (default, free) or `vector` (meaning, first page charged); `project`, `since`, `until`, `cursor`, `limit` (default 10, at most 50)), `mcp__memtree__read_node` (`node`, an address `<tree>#<id>` from search, or `id` with optional `tree`: summary, path from the root, children, leaf line range), `mcp__memtree__read_lines` (a leaf's `node`, or `block`, `start`, `end` with optional `tree`: exact transcript lines, at most 400 lines / 40k characters per call) (with `tail: true` instead, the newest messages after the tree that are not indexed yet) and `mcp__memtree__list` (your sessions, most recently active first; `since`, `until`, `project`, `q`, `cursor`, `limit`). Other sessions' trees are named explicitly by reference and authorized by your MemTree key. This session's tree (`tree: "current"`, or no `tree` on `read_node`/`read_lines`) is the one the current request was served from: the server asks the `ccc` proxy for `GET $ANTHROPIC_BASE_URL/memtree/current?session=<id>` (only that session's compression source page, or its stored source page on resume; `current.json?session=<id>` returns the page itself). Completed pages are cached. If the proxy temporarily serves an older prefix while a newer tree is indexing, the tools reuse that prefix during a 45-second cooldown, then check the page again. `ccc` registers it with `--mcp-config=<temp file>`, which keeps working under `--strict-mcp-config`, and pre-allows the four read-only tools; `CCC_MEMTREE_MCP=0` turns it off. The MCP process requires `CLAUDE_CODE_SESSION_ID` and checks that both the pointer and page belong to it. If Claude Code retains an MCP process with an old session ID after `/clear` or a session switch, reconnect the MCP server with the current session ID; it cannot infer a new identity from another session using the proxy. Print (`-p`) and non-TTY runs get it only when their own `--mcp-config` names a server `memtree` run by `ccc memtree-mcp` (add `--allowedTools mcp__memtree__search,mcp__memtree__read_node,mcp__memtree__read_lines,mcp__memtree__list`). Whenever the tools are configured, compress calls carry `x-memtree-tools: search,read_node,read_lines,list` so MemTree tells the model how to use them.

## How it works

<table><tr><td>
<img width="1050" height="445" alt="image" src="https://github.com/user-attachments/assets/d1ab2456-9a64-4118-a72a-b9d133c7c8bd" />
</td></tr></table>


When you send a message, we retrieve relevant details and summaries from the prior messages in your thread. These details and summaries populate a **memory message**. Following the memory message, we append a compressed version of your recent message history. The resulting context-window is dramatically smaller, allowing Claude to process your request with much greater efficacy, lower latency, and reduced cost.

**Compaction keeps a stable prefix.** While a conversation fits the model's budget (800k tokens for Opus 5.5), it is sent whole. When a request reaches the budget, `ccc` compresses it once, to half the budget (or your `/memtree-compact N`), and keeps those compressed bytes as the session's prefix. Every later request, human turns included, is that same prefix followed by the messages that came after it, verbatim, with no compression call (MemTree still indexes in the background). Because the prefix does not change, Anthropic reads it from the prompt cache on every turn after the one that compacted, instead of writing the whole compressed context again. `ccc` compresses again only when prefix plus newer turns reach the budget (measured from the size Anthropic reported for the previous request, plus an estimate for what was added), or when the messages the prefix stands for change (rewind, edit, fork, `/clear`). If that recompression fails, the turn is sent on the old prefix rather than the whole history. The prefix is also kept on disk, one file per session under `~/.claude-code-infinite/stable-prefixes/` (mode 600 in a private directory, at most 64 sessions and 256 MB, oldest dropped first), so the first turn after `ccc --resume` rides it instead of waiting on a fresh compression. A stored prefix belongs to the MemTree backend and key that wrote it (identified by a hash, never the key itself) and is never used with another. It is used only if the resumed history still matches what it replaced; a main-thread history that no longer matches discards it, while side requests (such as Claude Code's web-search helper) leave it alone. Only the main thread's prefix is stored, never a subagent's. The budget is the one MemTree reports for the model; until the server reports one, `ccc` uses 80% of the model's context window. `CCC_BUDGET_TOKENS=60k` overrides it for testing. Every `requests.jsonl` line carries the `pid` of the `ccc` process that wrote it, which tells apart concurrent sessions sharing the log. The same rule holds inside a tool loop, so a long single turn (a headless `-p` run, or a long agentic loop) is compacted as it grows rather than only when you next type: each tool request under the budget goes out with no compression call, the one that reaches it is compressed once and becomes the stable prefix, and later tool requests and your next message ride that prefix until it reaches the budget again. `requests.jsonl` shows the `compaction` of each main-thread human turn and of every tool turn (budget, its source, the size estimate, and the reason for a compaction: `budget`, `prefix-mismatch`, `manual` or `target-change`); a human turn sent on the stable prefix is `turnType: "followup-prefix"`, a tool turn `tool-memory` (on its route) or `tool-prefix` (on the prefix directly), and a tool turn that compacted `tool-recompressed`.

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

Releases are staged by GitHub Actions through npm Trusted Publishing (OIDC), so no npm
token, passkey or browser is needed to build and upload them, and each one is approved by a
maintainer before it goes live:

1. On a clean `main`, run `./publish.sh` (or `./publish.sh minor` / `major`). It builds,
   checks that `dist/` is committed, runs `npm version`, and pushes the commit and the
   `vX.Y.Z` tag.
2. The tag push runs [`.github/workflows/publish.yml`](.github/workflows/publish.yml): `npm ci`,
   the test suite with `NO_COLOR=1` and with `FORCE_COLOR=1`, a check that the rebuilt
   `dist/` matches the commit and that the tag equals `package.json`'s version, then
   `npm stage publish --provenance`.
3. Approve the staged version (2FA) on
   [npmjs.com](https://www.npmjs.com/package/claude-code-infinite) under the **Staged
   Packages** tab, or with `npm stage list claude-code-infinite` and
   `npm stage approve <stage-id>`. Until then it is not installable.

The trusted publisher on npmjs.com is bound to the workflow file name `publish.yml` with no
GitHub environment, and allows only staged publishing; renaming the workflow breaks it.
`./publish.sh --local` is the fallback: it publishes directly from your machine with npm web
auth, then pushes the commit and tag; the workflow still tests that tag but skips staging,
since the version is already published.

## Troubleshooting

### Anthropic auth errors (401s, login prompts)

`ccc` never touches your Anthropic credentials — Claude Code manages its own login exactly as it does without `ccc`. If you see auth errors, fix them the vanilla way: run `/login` inside Claude Code (or `claude` directly) and re-authenticate.

### MemTree degraded / passthrough mode

If you see an inline "⚠ MemTree degraded — this turn ran uncompressed" notice, the compression API is unreachable or your MemTree key is invalid/expired. Your session keeps working uncompressed. Check your key at [polychat.co](https://polychat.co/auth?memtree=true), or delete it from `~/.claude-code-infinite/config.json` and re-run `ccc` to re-enter it.

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
In every other case it only shows the update line:

- `npm link`ed or git checkouts (a development copy is never touched),
- `npx` and project-local installs,
- pnpm, yarn, bun and Volta global installs (update with your tool's own command),
- a global prefix that needs `sudo` to write, or `ccc` running as root,
- Windows,
- print (`-p`) and non-TTY runs, which never install anything.

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
