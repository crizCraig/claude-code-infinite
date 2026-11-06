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
/**
 * Whether subagents get the hint: on while the session has the memtree
 * `search` tool, off once ccc could not register the server after all.
 */
export declare class SubagentMemoryHint {
    private disabled;
    disable(): void;
    get enabled(): boolean;
}
/** The hint for a subagent of `sessionId`, or undefined when either id looks wrong. */
export declare function subagentMemoryHintText(sessionId: string, treeRef: string): string | undefined;
/**
 * Said to the parent when a (foreground) Agent/Task call returns: the result is only
 * the subagent's final message; its evidence is in its own MemTree tree, which nothing
 * else points at (xsession benchmark 2026-11-06: parents asked for a detail the
 * subagent read but didn't report resumed it or re-ran the work instead of searching).
 * Constant, so it adds no cache churn beyond its own few tokens.
 */
export declare const SUBAGENT_RESULT_HINT: string;
/** Agent tools whose PostToolUse gets SUBAGENT_RESULT_HINT. */
export declare const AGENT_TOOL_NAMES: readonly ["Agent", "Task"];
/**
 * Whether a PostToolUse input is a finished foreground subagent call: an Agent/Task
 * call not sent to the background (whose result is only a launch receipt).
 */
export declare function isFinishedSubagentCall(input: unknown): boolean;
/** The PostToolUse hook's answer carrying `context` to the model. */
export declare function postToolUseOutput(context: string): Record<string, unknown>;
/** The SubagentStart hook's answer carrying `context` to the subagent. */
export declare function subagentStartOutput(context: string): Record<string, unknown>;
//# sourceMappingURL=subagent-hint.d.ts.map