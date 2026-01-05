<p align="center">
  <img width="470" height="214" alt="cc-inf-wide-transparent" src="https://github.com/user-attachments/assets/1524e5dc-637f-4d25-9a15-f7f7b65c8182" />
</p>

# Claude Code Infinite

* Maximize Claude's intelligence with [MemTree.dev](https://memtree.dev), an advanced context-management engine
* Supports unlimited-length coding sessions
* Feels fast and fresh with every message
* Automatically recalls only the relevant past information
* Allows you to finish your work without summarizing, compacting, or starting a new session
 
## Requirements

* [node.js 18 or newer](https://nodejs.org/en/download/)
* [Claude Code (the terminal version)](https://code.claude.com/docs/en/quickstart)
* **Claude Subscription** - optional but highly recommended as this offers up to 1000x cost savings vs Anthropic's API pricing.
* A [PolyChat.co](https://polychat.co/pricing) subscription for continued access to the MemTree API after the free trial.

> [!NOTE]
> If you do not want to buy a Claude Code subscription, choose option 2. "Anthropic Console account", during the Claude Code setup.
>
> You don't need to buy API credits, just login and Claude Code will let you complete setup. API usage will be billed through https://polychat.co.
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

<table><tr><td>
<img width="1050" height="445" alt="image" src="https://github.com/user-attachments/assets/d1ab2456-9a64-4118-a72a-b9d133c7c8bd" />
</td></tr></table>


When you send a message, we retrieve relevant details and summaries from the prior messages in your thread. These details and summaries populate a **memory message**. Following the memory message, we append a compressed version of your recent message history. The resulting context-window is dramatically smaller, allowing Claude to process your request with much greater efficacy, lower latency, and reduced cost.

## What this is NOT

This is not a MPC or tool for simply retrieving memories. While we are compatible with all MPC's, tools, and other Anthropic features, these do not prevent your context window from becoming detrimentally large. MCP's and tools are some of the biggest token bloaters and it's exactly these types of messages that we heavily reduce during our compression phase.

## Why it works

LLMs get exponentially dumber as their input grows. 

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


## Usage

> [!TIP]
> If you want your session to apply to many different tasks, we recommend giving the overall high level goal you want for your session in the first message, e.g. "Refactor this project to remove code smells and bugs". Then followup with lower level tasks in subsequent messages.  This as Anthropic models key heavily off the first message. You should also feel free to start new sessions for new tasks. This as the model will continue to have a focused context with your CLAUDE.md and first message always included. Reach out to support@polychat.co if you have any questions or concerns!
