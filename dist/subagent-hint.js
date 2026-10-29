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
/** Claude Code session ids, and the server's tree refs (`<uuid>-v1-own`). */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TREE_REF = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
/**
 * Whether subagents get the hint: on while the session has the memtree
 * `search` tool, off once ccc could not register the server after all.
 */
export class SubagentMemoryHint {
    disabled = false;
    disable() {
        this.disabled = true;
    }
    get enabled() {
        return !this.disabled;
    }
}
/** The hint for a subagent of `sessionId`, or undefined when either id looks wrong. */
export function subagentMemoryHintText(sessionId, treeRef) {
    if (!SESSION_ID.test(sessionId) || !TREE_REF.test(treeRef))
        return undefined;
    return (`ccc: You are a subagent of session ${sessionId}, whose memory is MemTree tree ` +
        `${treeRef}; your own work is indexed too. Before re-deriving earlier decisions, ` +
        "findings or commands from the parent's work, search its memory: mcp__memtree__search " +
        `with tree ${treeRef} (or without tree to search all sessions).`);
}
/** The SubagentStart hook's answer carrying `context` to the subagent. */
export function subagentStartOutput(context) {
    return { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: context } };
}
//# sourceMappingURL=subagent-hint.js.map