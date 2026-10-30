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
 * given again, once per resume, even to a session begun on this version.
 *
 * Left out of an uncompressed session whose transcript already announced the
 * current instructions (begun on this version), when MemTree is not working
 * (paused, key refused, off, or its latest answer a failure), and on a
 * compaction: Claude Code's compaction drops every earlier announcement and
 * announces each server's current instructions again after the summary.
 * Print runs (`-p`, which resume on every call) have no SessionStart relay.
 */
import fs from "node:fs";
import { MEMTREE_MCP_INSTRUCTIONS, MEMTREE_TOOL_NAMES } from "./memtree-mcp.js";
export const RESUME_GUIDANCE_PREFIX = "ccc: current MemTree guidance (replaces any earlier MemTree instructions in this " +
    "conversation; its tools are mcp__memtree__*):";
export const RESUME_GUIDANCE = `${RESUME_GUIDANCE_PREFIX}\n\n${MEMTREE_MCP_INSTRUCTIONS}`;
/** The guidance hook's path: the notice hook's secret path plus this. */
export const RESUME_GUIDANCE_HOOK_SUFFIX = "/resume-guidance";
/**
 * How Claude Code's transcript holds the server's current instructions: the
 * JSON string body of the announced block (`## memtree\n…`). The guidance
 * above never contains it (no `## memtree` heading), so only a native
 * announcement of this version matches.
 */
export const ANNOUNCED_INSTRUCTIONS_NEEDLE = JSON.stringify(`## memtree\n${MEMTREE_MCP_INSTRUCTIONS}`).slice(1, -1);
/** A session's first announcement is near the start: read this much of it first. */
const HEAD_BYTES = 8 * 1024 * 1024;
/** Then read backward from the end in chunks of this size. */
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
/** A scan that has not found the announcement by then gives the guidance. */
export const ANNOUNCED_SCAN_MS = 1_000;
/**
 * Whether resumes get the guidance: on for an interactive run with MemTree on
 * and every memtree tool, off once ccc could not register the server after all.
 */
export class ResumeGuidance {
    scanMs;
    now;
    disabled = false;
    constructor(scanMs = ANNOUNCED_SCAN_MS, now = () => new Date()) {
        this.scanMs = scanMs;
        this.now = now;
    }
    disable() {
        this.disabled = true;
    }
    get enabled() {
        return !this.disabled;
    }
    /**
     * The guidance for a main session's SessionStart, or undefined. Never
     * throws; reads the transcript for at most `scanMs`.
     */
    async contextFor(input, state) {
        if (input.agent_id !== undefined)
            return undefined;
        if (input.source !== "resume" && input.source !== "fork")
            return undefined;
        if (!this.enabled || !state.working())
            return undefined;
        // Compressed: any earlier announcement, native or ours, may be out of view.
        if (state.compressed())
            return resumeGuidanceAgain(this.now());
        const path = input.transcript_path;
        if (path && (await fileContains(path, ANNOUNCED_INSTRUCTIONS_NEEDLE, this.scanMs))) {
            return undefined;
        }
        // MemTree may have paused or failed while the transcript was read.
        return this.enabled && state.working() ? RESUME_GUIDANCE : undefined;
    }
}
/** The guidance for a compressed session: new to Claude Code at each resume. */
export function resumeGuidanceAgain(at) {
    const minute = `${at.toISOString().slice(0, 16)}Z`;
    return `${RESUME_GUIDANCE}\n\n(Given again at the resume of ${minute}: MemTree has ` +
        "compressed this conversation, so an earlier copy may be out of view.)";
}
/** The gate for this run, or undefined (see ResumeGuidance). */
export function resumeGuidanceFor(s) {
    if (!s.interactive || s.memtreeOff)
        return undefined;
    if (!MEMTREE_TOOL_NAMES.every((tool) => s.tools.includes(tool)))
        return undefined;
    return new ResumeGuidance();
}
/**
 * Whether `file` contains `needle`: its head first, then backward from the
 * end, until `budgetMs` runs out. False when unknown (unreadable, too slow).
 */
export async function fileContains(file, needle, budgetMs, headBytes = HEAD_BYTES, chunkBytes = SCAN_CHUNK_BYTES) {
    const deadline = Date.now() + budgetMs;
    const target = Buffer.from(needle, "utf-8");
    let handle;
    try {
        handle = await fs.promises.open(file, "r");
        const size = (await handle.stat()).size;
        const head = Math.min(size, headBytes);
        if (await rangeContains(handle, 0, Math.min(size, head + target.length), target))
            return true;
        for (let end = size; end > head && Date.now() < deadline;) {
            const start = Math.max(head, end - chunkBytes);
            // Overlap the next (earlier) chunk so a match split between them is found.
            if (await rangeContains(handle, start, Math.min(end + target.length, size), target)) {
                return true;
            }
            end = start;
        }
        return false;
    }
    catch {
        return false;
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
async function rangeContains(handle, start, end, target) {
    if (end - start < target.length)
        return false;
    const buffer = Buffer.alloc(end - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.includes(target);
}
//# sourceMappingURL=resume-guidance.js.map