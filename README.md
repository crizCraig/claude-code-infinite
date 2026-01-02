<p align="center">
  <img width="470" height="214" alt="cc-inf-wide-transparent" src="https://github.com/user-attachments/assets/1524e5dc-637f-4d25-9a15-f7f7b65c8182" />
</p>

# Claude Code Infinite

* Maximize Claude's intelligence with [MemTree.dev](https://memtree.dev), an advanced context-management engine
* Supports unlimited-length coding sessions
* Feels fast and fresh with every message
* Automatically recalls only the relevant past information
* Allows you to finish your work without summarizing, compacting, clearing context, or starting a new session
 
## Requirements

* [node.js 18 or newer](https://nodejs.org/en/download/)
* [Claude Code (the terminal version)](https://code.claude.com/docs/en/quickstart)

> [!NOTE]
> We recommend using a Claude subscription due to the large cost savings they offer vs their API pricing.
> 
> However, if you do not want to buy a Claude Code subscription, choose option 2. "Anthropic Console account".
> 
> - Note that you don't need to buy API credits, just login and Claude Code will let you complete the setup wizard. API usage will be billed through https://polychat.co.
> 
> Then run `/logout` within Claude Code if you are **not** using a Claude subscription

## Setup

1. Install with npm
  ```bash
npm install -g claude-code-infinite
  ```
2. Run Claude Code Infinite with
  ```bash
  ccc
  ```

## How it works

When you send a message, we retrieve relevant details and summaries from the prior messages in your thread. These details and summaries populate a **memory message**. Following the memory message, we append a compressed version of your recent message history. The resulting context-window is dramatically smaller, allowing Claude to process your request with much greater efficacy, lower latency, and reduced cost.

## Why it works

LLM capabilities decline exponentially with input (i.e. context) size. 

cite: 
- 2023 - 2823 citations _Lost in the Middle: How Language Models Use Long Contexts:_ https://arxiv.org/abs/2307.03172
- by CP Hsieh · 2024 · Cited by 480 · _RULER: What's the Real Context Size of Your Long-Context Language Models?_
 https://arxiv.org/abs/2404.06654
- chroma
- others

Also, this research primarily tests on needle-in-a-haystack tasks, which underestimates the effect for more difficult tasks like coding, where relevant context is more dense.

This is why starting sessions from scratch provides such a significant uplift in ability to accomplish tasks. So what we're essentially doing is keeping each session as close to from-scratch as possible by limiting the tokens in Claude's context window to around 30k tokens, or 15% of the 200k context-limit. So even with Claude Code Infinite, it's still very fruitful to start new sessions. It's just that when you use Claude Code Infinite, you are getting much higher quality output per session, as without it, the token-usage can balloon past 100k tokens after just a couple file reads.

### Operating System Analogy

It may seem strange that we are advocating for small context windows in a product called Claude Code Infinite. But Infinite is referring to the size of a new memory layer, the MemTree, a layer above the context window. This layer is larger and updated more slowly than the LLMs main input, just like disk is larger and slower than RAM.

So you can think of MemTree as an operating system's virtual memory manager. Just as an OS manages RAM by swapping less-used data to disk, MemTree manages the model's context window by intelligently recalling only the most relevant information from past interactions. This ensures that the model always has access to the most pertinent data without being overwhelmed by the entire history of the conversation.


## Usage

> [!TIP]
> If you want your session to apply to many different tasks, we recommend giving the overall high level goal you want for your session in the first message, e.g. "Refactor this project to remove code smells and bugs". Then followup with lower level tasks in subsequent messages.  This as Anthropic models key heavily off the first message. You should also feel free to start new sessions for new tasks. This as the model will continue to have a focused context with your CLAUDE.md and first message always included. Reach out to support@polychat.co if you have any questions or concerns!
