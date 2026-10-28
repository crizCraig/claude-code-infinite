# Running agents on Claude Code Infinite (`ccc -p`)

**This guide is written for AI agents.** If you're a person, hand it to your agent (Claude,
Codex, Cursor, your own harness) and ask it to set itself up with long-term memory.

**Agent:** follow it to give yourself, or the agents you run, long-term memory through
Claude Code Infinite. You drive Claude Code headlessly with `ccc -p` instead of `claude -p`,
and each long-lived agent keeps one conversation that can run past the context limit without
losing what it learned. Step 1 needs your human once (a sign-up, a key paste and a Claude
login in a terminal); tell them exactly what to do, then everything after it runs unattended.

This guide is for ccc 1.0.23 and later. See [Older versions](#older-versions) for 1.0.22.

## 1. One-time setup (per person or machine)

1. You need a **Claude Pro or Max subscription** (Claude Code logs in with it).
2. Then, sign up for MemTree at https://polychat.co (a separate account from your Claude one)
   and create a MemTree key. Use your own account and don't
   share keys: every session on a key lands in that key's memory and search results.
3. Install ccc and run it once in a terminal, so it saves your MemTree key and Claude Code
   logs you in:
   ```bash
   npm install -g claude-code-infinite
   ccc            # paste your MemTree key when asked; log in to Claude if prompted; then /exit
   ```
   After this, headless runs work unattended. A headless run with no saved key exits with
   status 1 and says so on stderr; it never waits for input. ccc keeps itself updated
   automatically in interactive sessions.

## 2. The core pattern: one session per agent

Start a session, keep its id, and resume it on every call. The conversation (and its memory)
grows across calls. Once it nears the model's context limit, MemTree compresses it instead of
Claude Code's `/compact`, so details aren't wiped.

```bash
# First call: start the agent's session and capture its id
sid=$(printf '%s' "You are the inventory agent for ... (instructions)" \
      | ccc -p --output-format json | jq -r .session_id)

# Every later call: resume the same session
printf '%s' "Restock report for today: ..." \
  | ccc -p --resume "$sid" --output-format json | jq -r .result
```

You can also choose the id yourself: `ccc -p --session-id <uuid> "…"` for the first call, then
`ccc -p --resume <uuid> "…"`.

Rules of thumb:
- **One session per long-lived agent.** Store the `session_id` with the agent.
- **Run parallel work as subagents or forks.** Both are safe and are the recommended way to
  do several things at once:
  - *Subagents:* one session can run any number of subagents (the Agent/Task tool, in the
    foreground or with `run_in_background`) in parallel. Each writes its own transcript under
    `<session-id>/subagents/`, and MemTree indexes each one into its own tree (see section 3).
  - *Forks:* `ccc -p --resume "$sid" --fork-session "…"` starts a new session with the full
    history so far and returns a new `session_id`; the original is untouched. Run as many forks
    at once as you like, then store and resume each fork's own id. MemTree reuses the shared
    history's index, so a fork has its memory tree from its first call.
- **Don't run two processes on the same session id at once.** Claude Code doesn't lock a
  session, so two `ccc -p --resume "$sid"` calls running together both write to its transcript
  as sibling branches, and the next `--resume` continues only the branch that finished last.
  The other call's turn is dropped from the conversation without an error (it stays in the
  transcript file, but the agent no longer sees it). If the second call starts while
  the first is mid tool call, Claude Code also writes a "[Tool call interrupted…]" result into
  the history, which the agent then reads. Queue calls per session id, or fork.
- **Resume by id, not with `--continue`.** With `--continue`, Claude Code starts MCP servers
  before it switches to the continued session, so the memory tools can't open that session's own
  tree (`list` and searches across sessions still work).
- **Prefer a few long-lived agents over many one-shot calls.** A session gets its first memory
  tree once it has roughly 10k tokens of conversation; tiny one-off calls never get one.
- **Pipe the prompt on stdin**, or put it before any `--mcp-config`. Claude Code's
  `--mcp-config` takes several values and swallows a prompt placed after it; pass your own as
  `--mcp-config=<file>`.
- Use any Claude Code flags as usual (`--model`, `--allowedTools`, `--append-system-prompt`, ...).

**Output:** stdout carries only Claude Code's output, so `--output-format json` and
`stream-json` parse exactly as with `claude`. ccc's own lines (its banner, the environment and
the request log path) go to stderr.

## 3. Searching memory across sessions

Every ccc session, headless or interactive, gets MemTree's four read-only tools with no extra
flags: `mcp__memtree__search` (text or meaning, in this session's tree or across all your
sessions), `mcp__memtree__list`, `mcp__memtree__read_node` and `mcp__memtree__read_lines`. An
agent can look up what it or any other agent on the same key decided, tried or ruled out. ccc
pre-allows these four tools, so a `-p` run can call them without a permission prompt.

Your own flags win:
- `CCC_MEMTREE_MCP=0` turns the tools off.
- `--disallowedTools mcp__memtree` (or a single tool, or `mcp__memtree__*`) removes them;
  ccc neither pre-allows nor advertises a disallowed tool.
- Your `--allowedTools` list is kept: ccc adds only the four memtree tools to it.
- If your own `--mcp-config` defines a server named `memtree`, ccc adds nothing and yours is
  used. You don't need one, but if you write one, run ccc's server with
  `{"mcpServers": {"memtree": {"command": "ccc", "args": ["memtree-mcp"]}}}` and pre-allow
  the tools yourself with `--allowedTools`.

**Subagents' work is searchable too.** A subagent's own steps (files it read, commands it
ran) are in its own tree, not in its parent's: the parent's tree holds only what the subagent
reported back. So search without `tree` to find them (hits name the parent's session id and the
subagent's tree), not with `"tree": "current"`, which covers only the main conversation.
`list` shows one entry per session, with subagents under their parent; each fork is its own
session.

The tools can read every session your MemTree key owns. If your platform runs agents for
different people, give each person their own key, or set `CCC_MEMTREE_MCP=0`.

## 4. Seeing an agent's memory

Every session's memory is a tree you can open in the browser, search, share, or paste into any
agent as context. Your sessions and trees are listed at https://app.polychat.co/usage.

A headless run doesn't print its tree link (stdout stays Claude Code's). After a run, call
`ccc link` to show the agent's memory:

```bash
url=$(ccc link "$sid") && echo "Agent memory: $url"
```

`ccc link <session-id>` prints the session's newest MemTree page URL on stdout, one line and
nothing else; `--json` prints `{session_id, url, tree, updated_at}` (`updated_at` is the
session's last activity, which the tree can trail). It uses your saved key, so
it finds only your own sessions, and gives up after 5 seconds. Exit status:

| Status | Meaning |
| --- | --- |
| 0 | The URL was printed. |
| 1 | No saved key, or the MemTree server could not be reached or refused. |
| 2 | Bad invocation (no or malformed session id). |
| 3 | The session has no tree yet (it needs roughly 10k tokens of conversation), or your key has no session with that id; stderr says which. |

The link can trail by one call: a `-p` run's newest tree is built as it exits, so right after a
call `ccc link` may still show the tree from the call before (it catches up within a minute or
two). Other ways to see a tree:
- open the session from https://app.polychat.co/usage, or
- ask the agent: `mcp__memtree__list` returns each session with its latest tree link.

## 5. Useful settings

| Setting | Effect |
| --- | --- |
| `CCC_COMPACT_TARGET=500k` | Compress to this size when a session reaches the budget (default: half the budget). |
| `CCC_MEMTREE_MCP=0` | Turn off the MemTree tools. |
| `CCC_NO_UPDATE_CHECK=1` / `CCC_DISABLE_AUTOUPDATE=1` | Turn off update checks / automatic installs (e.g. to pin a version in CI). |
| `CCC_NO_DIAGNOSTICS=1` | Turn off anonymous client diagnostics (versions, OS, error codes; never content). |

## 6. Costs and terms

- Claude Code usage comes out of your Claude subscription, as with plain Claude Code.
- MemTree is billed per use on your polychat account (see https://app.polychat.co/usage).
- Running your **own** agents on your own subscription is normal Claude Code headless use. If
  your platform runs agents **for other people**, check Anthropic's terms for your case: they may
  require an API key instead.

## 7. Troubleshooting

- `--resume requires a valid session ID`: the id was empty or mistyped; parse it from the JSON
  as above.
- `A MemTree API key is required`: no key is saved for this user; run `ccc` once in a terminal.
- `Your MemTree key isn't valid (revoked or mistyped)` (stderr): polychat refused the saved key.
  The run carries on without MemTree; get a new key and run `ccc` in a terminal to paste it.
- A call that hangs ~2 minutes then fails on a huge session: MemTree has no index for it yet
  (e.g. a session moved between machines or accounts). It indexes in the background; retry later.
- Logs: `~/.claude-code-infinite/logs/requests.jsonl` (one line per request, no content).

## Older versions

ccc 1.0.22 and earlier differ in four ways:
- **Banner on stdout.** ccc prints a short banner before the JSON, so take the last line that
  starts with `{`: `ccc -p --output-format json … | grep '^{' | tail -1 | jq -r .result`.
- **No memory tools in `-p` runs.** The README's manual recipe (`--mcp-config` naming
  `ccc memtree-mcp`) works only without an environment word: `ccc staging memtree-mcp` starts a
  Claude session instead of the server and times out. Upgrade to get the tools by default.
- **No `ccc link`.** Use https://app.polychat.co/usage or `mcp__memtree__list` for tree links.
- **No saved key.** A headless run prints the key prompt to stdout and exits with status 0;
  check for a `session_id` in the output.
