/**
 * What a subagent is told about its parent's memory.
 *
 * A subagent (Claude Code's Agent/Task tool, foreground or background) starts
 * with only its prompt: the parent's earlier decisions, findings and commands
 * are in the parent's MemTree, which it can search with the memtree tools
 * (loaded up front there too: the server's `alwaysLoad`). So the proxy answers
 * Claude Code's SubagentStart hook with one short `additionalContext` naming
 * the parent session and its newest tree. Claude Code adds it once, to the
 * start of the subagent's own conversation, so it is cached with that prefix
 * and never changes for the subagent's later turns.
 *
 * Said only while MemTree works (not paused, not off, not before it first
 * answered), only when the session has the `search` tool it names, and only
 * when the server named the parent's newest tree: a parent without one has
 * little to re-derive.
 */

import { SESSION_ID } from "./memtree-newest.js";

/** The server's tree refs (`<uuid>-v1-own`). */
const TREE_REF = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

/**
 * Whether subagents get the hint: on while the session has the memtree
 * `search` tool, off once ccc could not register the server after all.
 */
export class SubagentMemoryHint {
  private disabled = false;

  disable(): void {
    this.disabled = true;
  }

  get enabled(): boolean {
    return !this.disabled;
  }
}

/** The hint for a subagent of `sessionId`, or undefined when either id looks wrong. */
export function subagentMemoryHintText(
  sessionId: string,
  treeRef: string
): string | undefined {
  if (!SESSION_ID.test(sessionId) || !TREE_REF.test(treeRef)) return undefined;
  return (
    `ccc: You are a subagent of session ${sessionId}, whose memory is MemTree tree ` +
    `${treeRef}; your own work is indexed too. Before re-deriving earlier decisions, ` +
    "findings or commands from the parent's work, search its memory: mcp__memtree__search " +
    `with tree ${treeRef} (or without tree to search all sessions).`
  );
}

/**
 * Said to the parent when a (foreground) Agent/Task call returns: the result is only
 * the subagent's final message; its evidence is in its own MemTree tree, which nothing
 * else points at (xsession benchmark 2026-11-06: parents asked for a detail the
 * subagent read but didn't report resumed it or re-ran the work instead of searching).
 * Constant, so it adds no cache churn beyond its own few tokens.
 */
export const SUBAGENT_RESULT_HINT =
  "ccc: This result is only the subagent's final message. Its own work (files it read, " +
  "commands and their output) is in MemTree, in its own tree, indexed as it ends. For a " +
  "detail it didn't report, mcp__memtree__search without tree (an id, name or term from " +
  "its task), then read_lines on the hit, before re-running its work.";

/** Agent tools whose PostToolUse gets SUBAGENT_RESULT_HINT. */
export const AGENT_TOOL_NAMES = ["Agent", "Task"] as const;

/**
 * Whether a PostToolUse input is a finished foreground subagent call: an Agent/Task
 * call that was not launched in the background, whose result is only a launch receipt.
 * Claude Code (2.1.319) also backgrounds agents without `run_in_background` (forced
 * async, `background: true` definitions, forks, remote isolation) and then answers
 * `tool_response.status` "async_launched" or "remote_launched"; a status, when there is
 * one, must be "completed".
 */
export function isFinishedSubagentCall(input: unknown): boolean {
  const raw = input as Record<string, unknown> | null;
  if (!raw || raw.hook_event_name !== "PostToolUse") return false;
  if (!(AGENT_TOOL_NAMES as readonly unknown[]).includes(raw.tool_name)) return false;
  const toolInput = raw.tool_input as Record<string, unknown> | undefined;
  if (toolInput?.run_in_background === true) return false;
  const status = (raw.tool_response as Record<string, unknown> | undefined)?.status;
  return status === undefined || status === "completed";
}

/** The PostToolUse hook's answer carrying `context` to the model. */
export function postToolUseOutput(context: string): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } };
}

/** The SubagentStart hook's answer carrying `context` to the subagent. */
export function subagentStartOutput(context: string): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: context } };
}
