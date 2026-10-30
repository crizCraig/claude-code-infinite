/**
 * The current MemTree guidance, given to a resumed session that lacks it.
 *
 * Claude Code announces each MCP server's instructions once, as an
 * `mcp_instructions_delta` in the transcript, and on a resume compares only
 * server names against what the transcript already announced: a server it
 * announced before is not announced again when its instructions changed
 * (Claude Code 2.1.314; a newer per-server comparison is behind a flag).
 * So a session begun under older instructions keeps them for good: Craig's
 * coordinator (2026-09-29) still had the first one-line version a month later.
 *
 * On an interactive resume (or fork) a SessionStart hook of its own adds the
 * current instructions as `additionalContext`, prefixed so the model knows
 * they replace the older ones. The text is constant (cached like the rest of
 * the conversation), and Claude Code adds a SessionStart context only when the
 * conversation does not already hold the identical text (2.1.314, verified on
 * staging): so a session gets it once, not once per resume, while that copy is
 * in view. Its own hook keeps it apart from the other SessionStart context
 * (earlier sessions in this project), which changes between resumes.
 *
 * Once MemTree has compressed the session, the memory message keeps no system
 * reminders: an earlier copy, and Claude Code's own announcement of the server
 * (seen on staging: the compressed request held neither), are out of view,
 * while Claude Code still holds them and would not add the copy again. Then a
 * resume adds a line naming the time, which makes the text new to Claude Code:
 * given again, once per resume, even to a session begun on this version. So
 * does a session ccc knows no page for (one too young for a tree, a fork's new
 * id, an evicted link store), unless its transcript announced the current text.
 *
 * Left out of an uncompressed session whose transcript already announced the
 * current instructions (begun on this version), when MemTree is not working
 * (paused, key refused, off, or its latest answer a failure), and on a
 * compaction: Claude Code's compaction drops every earlier announcement and
 * announces each server's current instructions again after the summary.
 * Print runs (`-p`, which resume on every call) have no SessionStart relay.
 */
export { RESUME_GUIDANCE_HOOK_SUFFIX } from "./hooks.js";
export declare const RESUME_GUIDANCE_PREFIX: string;
export declare const RESUME_GUIDANCE = "ccc: current MemTree guidance (replaces any earlier MemTree instructions in this conversation; its tools are mcp__memtree__*):\n\nThis session runs in Claude Code Infinite, which lets a conversation continue past the model's context window. MemTree indexes the whole conversation as it goes: a tree of summaries from a one-line overview at the root down to leaves, each pointing at the exact transcript lines it summarizes. Indexing runs in the background and trails the newest messages slightly.\n\nUntil the conversation reaches its size budget you see every message verbatim. The tools reach beyond this conversation: when the user refers to earlier work from another session (\"like last time\", \"the fix from yesterday\"), search without tree, or list recent sessions, before asking or re-deriving it.\n\nOnce the conversation reaches the budget, the earlier conversation is replaced by a single memory message: that tree, expanded where it looked relevant to the latest request and collapsed elsewhere. The user's own messages shown there, and everything after the memory message, stay word for word; the rest of the earlier conversation survives only as summaries, which drop exact values, instructions, reasoning and dead ends. The detail is not gone: these tools read it back.\n\nA nearly full context window is therefore expected and fine. Don't recommend /compact, /clear or a fresh session to free context: they discard what MemTree keeps (/ccc:memtree-compact compresses now if the user asks). The exception is a ccc notice that MemTree is paused or off: it is not compressing then, and that advice is the fallback.\n\nSo once you see that memory message: when your work depends on something from earlier in the session (what the user asked for or ruled out, decisions and why they were made, findings, ids and paths, commands, what was tried and failed), search MemTree before re-deriving it from the code or guessing. The code shows what exists; the memory shows what was decided and why. Read the exact lines (read_lines) when precision matters.\n\nsearch with \"tree\": \"current\" looks in this session's MemTree; without tree it searches all of the user's sessions, and list shows those sessions by time and project. Text mode (default, free) matches exact words, ids and paths; vector mode matches meaning: its first page is charged even when the query embedding is cached; cursor continuation is free, including when the embedding must be regenerated. Hits may include an address (<tree>#<node>) and its path from the root. If the address is unavailable, read_lines with the hit\u2019s tree.ref and range reads its exact lines. With an address: read_node {\"node\": address} opens it with its children, and the path's addresses lead to its parent and siblings; read_lines {\"node\": address} reads a leaf's exact lines. Cursors page over live results, not a frozen snapshot. A tree trails its conversation: the newest messages (often how a session ended) are in no tree yet. A text search of one tree also matches them (listed after the tree's hits), list shows how each session ended, and read_lines {\"tail\": true} reads them (with tree for another session's page; large tool calls are shortened, \"full\": true reads them whole).";
/**
 * How Claude Code's transcript holds the server's current instructions: the
 * JSON string body of the announced block (`## memtree\n…`). The guidance
 * above never contains it (no `## memtree` heading), and a match counts only
 * on an `mcp_instructions_delta` line (ANNOUNCEMENT_MARKER before it on the
 * line), not in a tool result or a paste that quotes it.
 */
export declare const ANNOUNCED_INSTRUCTIONS_NEEDLE: string;
/** A scan that has not found the announcement by then gives the guidance. */
export declare const ANNOUNCED_SCAN_MS = 1000;
export interface ResumeGuidanceStartup {
    interactive: boolean;
    /** Unpaid and [c] at the payment gate, or an invalid key: MemTree is off. */
    memtreeOff: boolean;
    /** The memtree tools the session has (bare names); the guidance names them all. */
    tools: readonly string[];
}
/** What a SessionStart needs to know about MemTree right now. */
export interface ResumeGuidanceState {
    /** Not paused, key not refused, latest answer (if any) a success. */
    working: () => boolean;
    /**
     * Whether MemTree's latest answer for this session compressed it, or
     * undefined when ccc knows no page for it (a fork's new id, an evicted or
     * unreadable link store).
     */
    compressed: () => boolean | undefined;
}
/**
 * Whether resumes get the guidance: on for an interactive run with MemTree on
 * and every memtree tool, off once ccc could not register the server after all.
 */
export declare class ResumeGuidance {
    private readonly scanMs;
    private readonly now;
    private disabled;
    constructor(scanMs?: number, now?: () => Date);
    disable(): void;
    get enabled(): boolean;
    /**
     * The guidance for a main session's SessionStart, or undefined. Never
     * throws; reads the transcript for at most `scanMs`.
     */
    contextFor(input: {
        source?: string;
        agent_id?: string;
        transcript_path?: string;
    }, state: ResumeGuidanceState): Promise<string | undefined>;
}
/** The guidance for a compressed session: new to Claude Code at each resume. */
export declare function resumeGuidanceAgain(at: Date): string;
/** The gate for this run, or undefined (see ResumeGuidance). */
export declare function resumeGuidanceFor(s: ResumeGuidanceStartup): ResumeGuidance | undefined;
/**
 * Whether `file` holds an announcement of `needle`: its head first, then
 * backward from the end. Answers within `budgetMs` whatever the filesystem
 * does (a stalled open or read is left to finish on its own): false when
 * unknown (unreadable, not a regular file, too slow).
 */
export declare function fileContains(file: string, needle: string, budgetMs: number, headBytes?: number, chunkBytes?: number): Promise<boolean>;
/** `work`'s answer, or `fallback` once `ms` pass first; never rejects. */
export declare function withinDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T>;
//# sourceMappingURL=resume-guidance.d.ts.map