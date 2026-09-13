<p align="center">
  <img width="470" height="214" alt="cc-inf-wide-transparent" src="https://github.com/user-attachments/assets/1524e5dc-637f-4d25-9a15-f7f7b65c8182" />
</p>

# Claude Code Infinite

* Maximize Claude's intelligence with context-management from [MemTree.dev](https://memtree.dev)
* Supports unlimited-length coding sessions
* Feels fast and fresh with every message
* Automatically recalls relevant past information
* Never compact again
 
## Requirements

* [node.js 18 or newer](https://nodejs.org/en/download/)
* [Claude Code (the terminal version)](https://code.claude.com/docs/en/quickstart)
* **Claude Subscription** - optional but highly recommended as this offers up to 1000x cost savings vs Anthropic's API pricing

## Setup

> [!TIP]
> No Anthropic subscription? See [Using Without an Anthropic Subscription](#using-without-an-anthropic-subscription) below.

1. Install with npm
  ```bash
npm install -g claude-code-infinite
  ```

Or straight from GitHub (no git needed, Node ≥ 18):

```bash
npm install -g https://github.com/crizCraig/claude-code-infinite/tarball/main
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
- **Staging**: `ccc staging` - Uses https://polychat-staging-421312241218.us-west2.run.app

Each environment maintains its own separate API key.

## Claude Code auto-compaction

`ccc` disables Claude Code's automatic conversation compaction for the Claude process it launches. MemTree manages the context sent to the model, so letting Claude Code independently summarize the full local transcript can compact a conversation MemTree already reduced. Manual `/compact` remains available.

Claude Code 2.1.219 also recommends “Resume from summary” for any old session
above a fixed 100k-token threshold, even when the active model has a 1M window
and auto-compaction is disabled. `ccc` suppresses that resume-time
recommendation as well; it does not disable the manual `/compact` command.

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

- `✓ MemTree · conversation optimized in 4.5s · ~330.3k → 94.6k tokens` when indexed conversation history was used and the completed memory response was selected. The success line is green when terminal color is available, and plain when `NO_COLOR` or a monochrome terminal is configured. `ccc` uses the standard ANSI green foreground sequence and Node's capability detection, so the same path works in ANSI terminals on macOS/Linux and supported Windows consoles. Latency is the client-observed MemTree request time. The before-count uses MemTree's informational `usage.raw_prompt_tokens` estimate, including visual-token estimates instead of image transport bytes; the after-count is Anthropic's actual full compressed-input usage. Claude's Count Tokens estimate remains a fallback for older MemTree servers. If neither before-count is available, `ccc` shows latency only.
- `⚠ MemTree degraded — this turn ran uncompressed` when a blocking compression call fails or times out.
- `⚠ MemTree is off — payment required…` once when compression and indexing are disabled for payment.

`ccc` installs a minimal session-only Claude Code plugin using the repeatable `--plugin-dir` option. Its `MessageDisplay` hook changes only what the terminal renders and never alters stored assistant content; a `Stop` hook supplies a fallback for tool-only responses. That fallback may be saved by Claude Code as non-model hook UI metadata, but it is excluded from resumed model and recap requests. Notices are never added to Anthropic responses or model context, and `-p`/non-TTY output is left unchanged. Legacy marker cleanup remains for transcripts created by older `ccc` releases. The payment state can also produce a separate terminal warning at startup.

Claude Code currently displays the original assistant text instead of `MessageDisplay` replacements while verbose mode is enabled. Turn verbose mode off to see the inline MemTree line.

## How it works

<table><tr><td>
<img width="1050" height="445" alt="image" src="https://github.com/user-attachments/assets/d1ab2456-9a64-4118-a72a-b9d133c7c8bd" />
</td></tr></table>


When you send a message, we retrieve relevant details and summaries from the prior messages in your thread. These details and summaries populate a **memory message**. Following the memory message, we append a compressed version of your recent message history. The resulting context-window is dramatically smaller, allowing Claude to process your request with much greater efficacy, lower latency, and reduced cost.

That compressed context stays in force for the rest of the turn: the tool loop it kicks off, and the matching Count Tokens calls, are routed through the same compressed prefix. The Count Tokens part matters — Claude Code sizes its context from those replies, so counting the uncompressed history would make it auto-compact a conversation memory had already shrunk. A mismatched or resumed conversation shape drops the route rather than grafting one session's prefix onto another.

Compressed prefixes are stored per *lane*, not in a single slot: the main thread, each subagent, and the away-summary side channel each key their own route by session and identity. Every lane gets the same deal — it installs its own prefix and rides it — and lanes cannot evict one another, so a subagent or a background side request can no longer strand the main conversation on full history.

If a tool request arrives without a usable compressed prefix (for example after an interrupted turn), `ccc` makes a best-effort blocking MemTree recompression before forwarding, then installs the result as that lane's prefix so the rest of its tool loop rides locally. This is a soft recovery, not a hard cap: if MemTree is unavailable or returns nothing usable within its normal compression budget, the original request is forwarded unchanged, and a failed attempt puts recovery on a brief cooldown so an outage costs one stall rather than one per tool call. Each lane gets **one** blocking attempt per human turn, whatever the request size, so a lane that misses repeatedly forwards verbatim instead of recompressing on every tool call. A request with no session id is compressed without installing, since a route that cannot be matched later must not be stored. `CCC_TOOL_ROUTE_RECOVERY=0` temporarily disables the recovery for one invocation; outcomes are recorded in `~/.claude-code-infinite/logs/requests.jsonl` under `routeLane`/`routeMiss`/`routeRecovery`.

Routing decisions, per-turn timings and usage, recovery outcomes, and delivery status are recorded in `~/.claude-code-infinite/logs/requests.jsonl`.

Memory quality is evaluated offline: the weekly `memtree-bench` harness replays a fixed scenario through a ccc-wrapped arm and a vanilla Claude Code arm and grades complete outcomes blind against an answer key. (An earlier in-request memory-vs-full A/B comparison with a live grader was removed in 2026-08; it was off by default, and the offline benchmark measures the same question with a stronger instrument.)

## What this is NOT

This is not a MPC or tool for simply retrieving memories. While we are compatible with all MPC's, tools, and other Anthropic features, these do not prevent your context window from becoming detrimentally large. MCP's and tools are some of the biggest token bloaters and it's exactly these types of messages that we heavily reduce during our compression phase.

## Why it works

LLMs get exponentially less intelligent as their input grows. 

References:
- [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172) (2023)
- [RULER: What's the Real Context Size of Your Long-Context Language Models?](https://arxiv.org/abs/2404.06654) (2024)
- <a href="https://research.trychroma.com/context-rot" target="_blank" rel="noopener noreferrer">Context Rot from Chroma</a> (2025)
 
<a href="https://www.youtube.com/watch?v=TUjQuC4ugak" target="_blank" rel="noopener noreferrer">
  <img src="https://img.youtube.com/vi/TUjQuC4ugak/0.jpg" alt="Context Rot Video">
</a>


Furthermore, the above research primarily tests on needle-in-a-haystack tasks, which underestimates the effect for more difficult tasks encountered in coding.

This is why starting sessions from scratch provides such a significant uplift in ability. What we're essentially doing is keeping each session as close to from-scratch as possible by limiting the tokens in Claude's context window to around 30k, filled precisely with the information relevant to your **last** message. Read more about how MemTree works [here](https://api.polychat.co/context-memory).

### Operating System Analogy

It may seem strange that we are advocating for small context windows in a product called Claude Code Infinite. But Infinite is referring to the size of a new memory layer, the MemTree, which is a layer above the context window. This layer is larger and updated more slowly than the LLMs main input, just as disk is larger + slower than RAM.

So you can think of MemTree as an operating system's virtual memory manager. Just as an OS manages RAM by swapping less-used data to disk, MemTree manages the model's context window by intelligently recalling only the most relevant information from past interactions. This ensures that the model always has access to the most pertinent data without being overwhelmed by the entire history of the conversation.


## Usage Tips

* If you want your session to apply to many different tasks, we recommend giving the overall high level goal you want for your session in the first message, e.g. "Refactor this project to remove code smells and bugs". Then followup with lower level tasks in subsequent messages.  This as Anthropic models key heavily off the first message. You should also feel free to start new sessions for new tasks. This as the model will continue to have a focused context with your CLAUDE.md and first message always included. Reach out to support@polychat.co if you have any questions or concerns!

* Add context to your status line to see how MemTree keeps your context small
  ```bash
  /statusline add context % used
  ```
* You want your fresh session context to be **10k** tokens or less. If your starting context is more than that, consider reducing the size of your custom MCP's and slash commands to ensure Claude performs at its very best

* You can resume previous threads with `/resume`


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

Set `CCC_SKIP_UPDATE_CHECK=1` to disable the check (air-gapped or CI runs).

