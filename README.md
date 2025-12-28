<p align="center">
  <img width="470" height="214" alt="cc-inf-wide-transparent" src="https://github.com/user-attachments/assets/1524e5dc-637f-4d25-9a15-f7f7b65c8182" />
</p>

# Claude Code Infinite

* Maximize Claude's intelligence with [MemTree.dev](https://memtree.dev), a state-of-the-art context-management engine
* Supports unlimited-length coding sessions
* Feels fast and fresh with every message
* Automatically recalls only relevant past information
* Allows you to finish your work without summarizing, compacting, clearing context, or starting a new session

## Requirements

* [Claude Code (the terminal version)](https://code.claude.com/docs/en/quickstart)
* [node.js 18 or newer](https://nodejs.org/en/download/)

## Setup

1. Install with npm
  ```bash
npm install -g claude-code-infinite
  ```
2. Run Claude Code Infinite with
  ```bash
  cc-inf
  ```

## How it works

When you send a message, we retrieve relevant details and summaries from the prior messages in your thread. These details and summaries populate a **memory message**. Following the memory message, we append a compressed version of your recent message history. The resulting context-window is dramatically smaller, allowing Claude to process your request with much greater efficacy, lower latency, and reduced cost.

## Usage

> [!TIP]
> If you want your session to apply to many different tasks, we recommend giving the overall high level goal you want for your session in the first message, e.g. "Refactor this project to remove code smells and bugs". Then followup with lower level tasks in subsequent messages.  This as Anthropic models key heavily off the first message. You should also feel free to start new sessions for new tasks. This as the model will continue to have a focused context with your CLAUDE.md and first message always included. Reach out to support@polychat.co if you have any questions or concerns!

## Known Issues: 
- Running a `/resume` on a very long conversation can change the message history and therefore invalidate our index. So, if you resume, you may have to wait for your messages to be re-indexed. Altneratively, you can start a new thread to continue working right away.
