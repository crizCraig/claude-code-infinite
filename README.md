<p align="center">
  <img width="692" height="314" alt="image" src="https://github.com/user-attachments/assets/8228030c-1e35-48d0-b836-04d903498869" />
</p>

# Claude Code Infinite

### Finish your feature without starting a new session

### Never run `/compact` again

_Claude Code can now handle infinitely long sessions using [PolyChat's](https://polychat.co) memory API, [MemTree](https://memtree.dev)._

## Requirements

* A Unix shell on Mac, Linux, or WSL in Windows

## Setup

1. Install [Claude Code](https://www.claude.com/product/claude-code) in your Unix shell

2. Install Claude Code **✨Infinite✨** wrapper via [npm](https://nodejs.org/):
  ```bash
npm install -g claude-code-infinite
  ```
3. Run
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
