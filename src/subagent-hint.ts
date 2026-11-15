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

import type { KeyCheck } from "./key-status.js";
import { hybridSearchOn } from "./memtree-finder.js";
import { SESSION_ID } from "./memtree-newest.js";

/** The server's tree refs (`<uuid>-v1-own`). */
const TREE_REF = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

/**
 * Whether subagents get the hint: on while the session has the memtree
 * `search` tool, off once ccc could not register the server after all.
 */
export class SubagentMemoryHint {
  private disabled = false;

  /**
   * The SubagentStart wording (PARENT_TREE_ENV; the shipped hint unless switched), and
   * whether this process's search defaults to hybrid (the note says so only then).
   */
  constructor(readonly style: ParentTreeStyle = "shipped", readonly hybrid = true) {}

  disable(): void {
    this.disabled = true;
  }

  get enabled(): boolean {
    return !this.disabled;
  }
}

/**
 * The subagent hints for this run, or undefined: the session needs the `search` tool
 * they name, and MemTree must not be known off at startup (an invalid key, or [c] at
 * the payment gate). The proxy's own working check can't know that before MemTree
 * answers a request, and the after-a-subagent line is given before then too.
 */
export function subagentHintFor(s: {
  tools: readonly string[];
  keyCheck: KeyCheck;
  memtreeOff: boolean;
  env?: NodeJS.ProcessEnv;
}): SubagentMemoryHint | undefined {
  if (!s.tools.includes("search") || s.keyCheck === "invalid" || s.memtreeOff) return undefined;
  const env = s.env ?? {};
  return new SubagentMemoryHint(
    styleForTools(parentTreeStyleFromEnv(env), s.tools), hybridSearchOn(env));
}

/**
 * The style the session's tools allow: every note names read_lines (else the shipped
 * hint, which names only search), and `outline` read_node too (else the pointer).
 */
export function styleForTools(style: ParentTreeStyle, tools: readonly string[]): ParentTreeStyle {
  if (style === "shipped" || style === "none") return style;
  if (!tools.includes("read_lines")) return "shipped";
  return style === "outline" && !tools.includes("read_node") ? "pointer" : style;
}

/**
 * `CCC_SUBAGENT_PARENT_TREE`: how a subagent is told about its parent's MemTree (off by
 * default). Unset, `0` or `off`: the shipped one-line hint. `1` or `on`: the default note
 * below (PARENT_TREE_DEFAULT_STYLE). A style name picks that wording (the plan-savings
 * benchmark compares them on one build); `none` says nothing at SubagentStart (a
 * benchmark baseline). Anything else reads as off.
 */
export const PARENT_TREE_ENV = "CCC_SUBAGENT_PARENT_TREE";

/** The parent-tree note's wordings (parentTreeNote), plus the shipped hint and none. */
export const PARENT_TREE_STYLES = [
  "shipped", "none", "pointer", "search-first", "example", "outline", "first-step",
] as const;
export type ParentTreeStyle = (typeof PARENT_TREE_STYLES)[number];

/** What `CCC_SUBAGENT_PARENT_TREE=1` means. */
// first-step: in the plan-savings pilot (2026-11-15) the only wording subagents acted on.
export const PARENT_TREE_DEFAULT_STYLE: ParentTreeStyle = "first-step";

/** The style PARENT_TREE_ENV selects. */
export function parentTreeStyleFromEnv(env: NodeJS.ProcessEnv): ParentTreeStyle {
  const value = String(env[PARENT_TREE_ENV] ?? "").trim().toLowerCase();
  if (["1", "on", "true", "yes"].includes(value)) return PARENT_TREE_DEFAULT_STYLE;
  return (PARENT_TREE_STYLES as readonly string[]).includes(value)
    ? (value as ParentTreeStyle) : "shipped";
}

/**
 * The hint for a subagent of `sessionId` in `style`, or undefined when either id looks
 * wrong or the style says nothing.
 */
export function subagentMemoryHintText(
  sessionId: string,
  treeRef: string,
  style: ParentTreeStyle = "shipped",
  hybrid = true
): string | undefined {
  if (!SESSION_ID.test(sessionId) || !TREE_REF.test(treeRef) || style === "none") {
    return undefined;
  }
  if (style !== "shipped") return parentTreeNote(sessionId, treeRef, style, hybrid);
  return (
    `ccc: You are a subagent of session ${sessionId}, whose memory is MemTree tree ` +
    `${treeRef}; your own work is indexed too. Before re-deriving earlier decisions, ` +
    "findings or commands from the parent's work, search its memory: mcp__memtree__search " +
    `with tree ${treeRef} (or without tree to search all sessions).`
  );
}

/**
 * The parent-tree note (PARENT_TREE_ENV): the parent's memory by its session id, which
 * every memtree tool resolves to that session's newest tree at call time (memtree-mcp.ts
 * sessionAsTree), so the note stays true as the parent's tree grows, and its bytes never
 * change for the subagent's turns (SubagentStart context, added once). The tree it had at
 * the start is named too. Same account only: the ref came from this key's own sessions,
 * and the tools read with the same key. Then how to use it, per style.
 */
function parentTreeNote(
  sessionId: string,
  treeRef: string,
  style: ParentTreeStyle,
  hybrid: boolean
): string {
  const tree = `"tree": "${sessionId}"`;
  const pointer =
    `ccc: You are a subagent of session ${sessionId}. What it read, ran, found and decided ` +
    `before delegating to you is in its MemTree (tree ${treeRef} at your start): pass ` +
    `${tree} to the mcp__memtree__ tools for its newest tree. search finds things` +
    `${hybrid ? " (hybrid by default)" : ""}; read_lines on a hit (its address, or its ` +
    "tree ref and range) gives the exact lines (summaries drop values); " +
    `read_lines {${tree}, "tail": true} reads its newest messages, which no tree covers yet.`;
  return pointer + (PARENT_TREE_ADVICE[style] ?? "").replaceAll("@TREE@", tree);
}

/** What each style adds to the pointer (`@TREE@`: the tree argument). */
const PARENT_TREE_ADVICE: Partial<Record<ParentTreeStyle, string>> = {
  "search-first":
    " Search there for what the parent already read, found or ran before re-deriving it or " +
    "re-reading its logs; memory shows files as they were then, so read a file yourself for " +
    "its current contents or to edit it.",
  example:
    " For example: search {@TREE@, \"query\": \"<an id, file or error from your task>\"}, " +
    "then read_lines on the best hit for its exact lines.",
  outline:
    " Start with read_node {@TREE@, \"id\": 0}: the parent's outline; its children lead " +
    "to what it covered.",
  // An instruction, not advice: in the plan-savings pilot (2026-11-15) subagents given the
  // advisory styles never searched; their brief named the logs and they re-read them.
  "first-step":
    " Your task may continue the parent's work, so make your first tool call search " +
    "{@TREE@, \"query\": \"<your task's key terms>\"} and use what the parent already " +
    "found instead of re-reading logs or re-deriving it; read files for their current " +
    "contents or to edit them.",
};

/**
 * Said to the parent after each Agent/Task call: a subagent's result (returned now, or
 * as a notification when it was launched in the background, which `-p` runs mostly
 * are) is only its final message; its evidence is in its own MemTree tree, which
 * nothing else points at. xsession benchmark 2026-11-06: parents asked for a detail
 * the subagent read but didn't report searched only their own tree, resumed the
 * subagent or re-ran the work; with this line they searched memory first. Worded to be
 * true at launch and at completion. Constant: no cache churn beyond its own tokens.
 */
export const SUBAGENT_RESULT_HINT =
  "ccc: A subagent's result is only its final message. Its own work (files it read, " +
  "commands and their output) is in MemTree, in its own tree, indexed when it ends. For a " +
  "detail it didn't report, mcp__memtree__search without tree (an id, name or term from " +
  "its task), then read_lines on the hit, before re-running its work.";

/** Agent tools whose PostToolUse gets SUBAGENT_RESULT_HINT. */
export const AGENT_TOOL_NAMES = ["Agent", "Task"] as const;

/** Whether a PostToolUse input is an Agent/Task call (foreground, or a background launch). */
export function isSubagentCall(input: unknown): boolean {
  const raw = input as Record<string, unknown> | null;
  if (!raw || raw.hook_event_name !== "PostToolUse") return false;
  return (AGENT_TOOL_NAMES as readonly unknown[]).includes(raw.tool_name);
}

/** The PostToolUse hook's answer carrying `context` to the model. */
export function postToolUseOutput(context: string): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } };
}

/** The SubagentStart hook's answer carrying `context` to the subagent. */
export function subagentStartOutput(context: string): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: context } };
}
