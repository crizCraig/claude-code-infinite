<p align="center">
  <img width="470" height="214" alt="cc-inf-wide-transparent" src="https://github.com/user-attachments/assets/1524e5dc-637f-4d25-9a15-f7f7b65c8182" />
</p>

# Claude Code Infinite

* Maximize Claude's intelligence with context-management from [MemTree.dev](https://memtree.dev)
* Supports unlimited-length coding sessions
* Feels fast and fresh with every message
* Automatically recalls only the relevant past information
* Allows you to continue your session without summarizing or compacting
 
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
2. Run Claude Code Infinite with
  ```bash
  ccc
  ```

This will guide you through setting up your PolyChat key, which you can also get [here](https://polychat.co/auth?memtree=true).

## Environments

The tool supports multiple environments (this selects the MemTree compression API only — Anthropic traffic always goes directly from your machine to api.anthropic.com):

- **Production** (default): `ccc` - Uses https://api.polychat.co
- **Local**: `ccc local` - Uses http://localhost:8080 for local development
- **Staging**: `ccc staging` - Uses https://polychat-staging-421312241218.us-west2.run.app

Each environment maintains its own separate API key.

## Privacy & architecture: your Anthropic credentials never leave your machine

`ccc` runs a small proxy on `127.0.0.1` and launches Claude Code with only `ANTHROPIC_BASE_URL` pointed at it. Claude Code keeps its **native login** — token refresh, plan-default model selection, and rate-limit handling behave exactly like vanilla Claude Code, and your OAuth token is sent only to `api.anthropic.com` from your own machine.

```
Claude Code ──▶ localhost proxy (ccc)
                  ├──(messages only, MemTree API key)──▶ api.polychat.co /v1/context_memory
                  │◀──(compressed messages)─────────────┘
                  ├──(memory leg A + your local OAuth)──▶ api.anthropic.com
                  ├──(eligible turns: full-history leg B)▶ api.anthropic.com
                  └──(eligible turns: local A/B grader)──▶ api.anthropic.com
```

- Only message content is sent to MemTree for indexing/compression — never credentials.
- Answer legs and the grader go directly from the local proxy to Anthropic using the authentication Claude Code supplied. PolyChat never sees that credential or Anthropic traffic.
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

### Adaptive memory A/B routing

`ccc` now checks whether memory is still the best context for each large follow-up turn:

1. It estimates the size of the entire compressed request. Below 50% of the model's measured effective-context prior, it sends only the memory request.
2. Above that gate, it starts two streaming requests concurrently: A uses compressed memory and B uses the full history. Models without a prior are compared by default.
3. The memory answer streams to the client immediately (speculative delivery — first-token latency is A's own). The semantic prefix of each answer (about 1,000 tokens) is graded in the background by a structured Anthropic grader; A and ties keep memory, and only a materially better B interrupts the in-flight message, visibly correcting course with a short bridge line before continuing from the full-history answer.
4. A memory winner remains active through that human turn's tool loop, including matching Count Tokens calls. The original full tool history is still sent to MemTree for background indexing.

Comparison is deliberately fail-safe: grader failure or timeout keeps memory (the grader is retried once off the delivery path), a memory arm that dies mid-stream is recovered from the healthy full-history arm, and client cancellation aborts both arms and the grader. A route and success notice are installed only after a complete successful response. Once the memory answer has finished — or has started a tool call — a late B verdict is recorded for research but never applied.

Qualifying turns cost more: they make two answer requests plus one grader request on the user's Anthropic subscription or API account. The gate avoids that overhead for compact contexts, and the losing answer is aborted right after grading.

Advanced/testing controls:

- `ccc --ab-buffered` retains the previous buffer-both-then-commit delivery (for research comparison runs); the default is speculative delivery.

- `CCC_AB_ROUTING=0` disables live A/B routing.
- `CCC_AB_GRADER_MODEL=<model>` overrides the default grader (`claude-opus-4-8`).
- `CCC_AB_PREFIX_TOKENS=<n>` changes the answer prefix from its 1,000-token default.
- `CCC_AB_PREFIX_TIMEOUT_MS=<ms>` and `CCC_AB_GRADER_TIMEOUT_MS=<ms>` change their 30-second defaults.
- `CCC_AB_SAMPLE_NO_PRIOR=0` skips comparison for models without an effective-context prior.
- `CCC_AB_FORCE_COMPARISON=1` bypasses the size gate for diagnostics.

Routing decisions, both-leg timings and usage, grader diagnostics, fallbacks, and delivery status are recorded in `~/.claude-code-infinite/logs/requests.jsonl`.

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

This is why starting sessions from scratch provides such a significant uplift in ability. What we're essentially doing is keeping each session as close to from-scratch as possible by limiting the tokens in Claude's context window to around 30k, or 15% of the standard 200k context-limit, filled precisely with the information relevant to your **last** message. Read more about how MemTree works [here](https://api.polychat.co/context-memory).

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

## Using Without an Anthropic Subscription

Claude Code works with an Anthropic API key as well as a subscription — set `ANTHROPIC_API_KEY` as you would with vanilla Claude Code and run `ccc` as usual. MemTree compression works the same either way (and saves the most money on API-key billing, since you pay per token).
