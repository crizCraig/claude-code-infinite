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
/**
 * Whether subagents get the hint: on while the session has the memtree
 * `search` tool, off once ccc could not register the server after all.
 */
export declare class SubagentMemoryHint {
    private disabled;
    disable(): void;
    get enabled(): boolean;
}
/**
 * The subagent hints for this run, or undefined: the session needs the `search` tool
 * they name, and MemTree must not be known off at startup (an invalid key, or [c] at
 * the payment gate). The proxy's own working check can't know that before MemTree
 * answers a request, and the after-a-subagent line is given before then too.
 */
export declare function subagentHintFor(s: {
    tools: readonly string[];
    keyCheck: KeyCheck;
    memtreeOff: boolean;
}): SubagentMemoryHint | undefined;
/** The hint for a subagent of `sessionId`, or undefined when either id looks wrong. */
export declare function subagentMemoryHintText(sessionId: string, treeRef: string): string | undefined;
/**
 * Said to the parent after each Agent/Task call: a subagent's result (returned now, or
 * as a notification when it was launched in the background, which `-p` runs mostly
 * are) is only its final message; its evidence is in its own MemTree tree, which
 * nothing else points at. xsession benchmark 2026-11-06: parents asked for a detail
 * the subagent read but didn't report searched only their own tree, resumed the
 * subagent or re-ran the work; with this line they searched memory first. Worded to be
 * true at launch and at completion. Constant: no cache churn beyond its own tokens.
 */
export declare const SUBAGENT_RESULT_HINT: string;
/** Agent tools whose PostToolUse gets SUBAGENT_RESULT_HINT. */
export declare const AGENT_TOOL_NAMES: readonly ["Agent", "Task"];
/** Whether a PostToolUse input is an Agent/Task call (foreground, or a background launch). */
export declare function isSubagentCall(input: unknown): boolean;
/** The PostToolUse hook's answer carrying `context` to the model. */
export declare function postToolUseOutput(context: string): Record<string, unknown>;
/** The SubagentStart hook's answer carrying `context` to the subagent. */
export declare function subagentStartOutput(context: string): Record<string, unknown>;
//# sourceMappingURL=subagent-hint.d.ts.map