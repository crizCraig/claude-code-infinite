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
/** The SubagentStart hook's answer carrying `context` to the subagent. */
export declare function subagentStartOutput(context: string): Record<string, unknown>;
//# sourceMappingURL=subagent-hint.d.ts.map