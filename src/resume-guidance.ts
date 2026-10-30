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

import fs from "node:fs";
import { MEMTREE_MCP_INSTRUCTIONS, MEMTREE_TOOL_NAMES } from "./memtree-mcp.js";

export { RESUME_GUIDANCE_HOOK_SUFFIX } from "./hooks.js";

export const RESUME_GUIDANCE_PREFIX =
  "ccc: current MemTree guidance (replaces any earlier MemTree instructions in this " +
  "conversation; its tools are mcp__memtree__*):";
export const RESUME_GUIDANCE = `${RESUME_GUIDANCE_PREFIX}\n\n${MEMTREE_MCP_INSTRUCTIONS}`;

/**
 * How Claude Code's transcript holds the server's current instructions: the
 * JSON string body of the announced block (`## memtree\n…`). The guidance
 * above never contains it (no `## memtree` heading), and a match counts only
 * on an `mcp_instructions_delta` line (ANNOUNCEMENT_MARKER before it on the
 * line), not in a tool result or a paste that quotes it.
 */
export const ANNOUNCED_INSTRUCTIONS_NEEDLE = JSON.stringify(
  `## memtree\n${MEMTREE_MCP_INSTRUCTIONS}`
).slice(1, -1);
/** An announcement line's marker is at most this far before its block. */
const LINE_CONTEXT_BYTES = 64 * 1024;
const ANNOUNCEMENT_MARKER = Buffer.from('"type":"mcp_instructions_delta"', "utf-8");

/** A session's first announcement is near the start: read this much of it first. */
const HEAD_BYTES = 8 * 1024 * 1024;
/** Then read backward from the end in chunks of this size. */
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
/** A scan that has not found the announcement by then gives the guidance. */
export const ANNOUNCED_SCAN_MS = 1_000;

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
export class ResumeGuidance {
  private disabled = false;

  constructor(
    private readonly scanMs = ANNOUNCED_SCAN_MS,
    private readonly now: () => Date = () => new Date()
  ) {}

  disable(): void {
    this.disabled = true;
  }

  get enabled(): boolean {
    return !this.disabled;
  }

  /**
   * The guidance for a main session's SessionStart, or undefined. Never
   * throws; reads the transcript for at most `scanMs`.
   */
  async contextFor(
    input: { source?: string; agent_id?: string; transcript_path?: string },
    state: ResumeGuidanceState
  ): Promise<string | undefined> {
    if (input.agent_id !== undefined) return undefined;
    if (input.source !== "resume" && input.source !== "fork") return undefined;
    if (!this.enabled || !state.working()) return undefined;
    // Compressed: any earlier announcement, native or ours, may be out of view.
    if (state.compressed() === true) return resumeGuidanceAgain(this.now());
    const path = input.transcript_path;
    if (path && (await fileContains(path, ANNOUNCED_INSTRUCTIONS_NEEDLE, this.scanMs))) {
      return undefined;
    }
    // MemTree may have paused or failed while the transcript was read.
    if (!this.enabled || !state.working()) return undefined;
    // No page known (a young session, a fork's new id, a lost link store): it
    // may be compressed, and Claude Code would drop an identical earlier copy.
    return state.compressed() === false ? RESUME_GUIDANCE : resumeGuidanceAgain(this.now());
  }
}

/** The guidance for a compressed session: new to Claude Code at each resume. */
export function resumeGuidanceAgain(at: Date): string {
  return `${RESUME_GUIDANCE}\n\n(Given again at the resume of ${at.toISOString()}: ` +
    "MemTree may have compressed this conversation, so an earlier copy may be out of view.)";
}

/** The gate for this run, or undefined (see ResumeGuidance). */
export function resumeGuidanceFor(s: ResumeGuidanceStartup): ResumeGuidance | undefined {
  if (!s.interactive || s.memtreeOff) return undefined;
  if (!MEMTREE_TOOL_NAMES.every((tool) => s.tools.includes(tool))) return undefined;
  return new ResumeGuidance();
}

/**
 * Whether `file` holds an announcement of `needle`: its head first, then
 * backward from the end. Answers within `budgetMs` whatever the filesystem
 * does (a stalled open or read is left to finish on its own): false when
 * unknown (unreadable, not a regular file, too slow).
 */
export function fileContains(
  file: string,
  needle: string,
  budgetMs: number,
  headBytes = HEAD_BYTES,
  chunkBytes = SCAN_CHUNK_BYTES
): Promise<boolean> {
  return withinDeadline(scanFile(file, needle, budgetMs, headBytes, chunkBytes), budgetMs, false);
}

/** `work`'s answer, or `fallback` once `ms` pass first; never rejects. */
export function withinDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(resolve, () => resolve(fallback)).finally(() => clearTimeout(timer));
  });
}

async function scanFile(
  file: string,
  needle: string,
  budgetMs: number,
  headBytes: number,
  chunkBytes: number
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  const target = Buffer.from(needle, "utf-8");
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) return false;
    const size = stat.size;
    const head = Math.min(size, headBytes);
    if (await rangeContains(handle, 0, Math.min(size, head + target.length), target)) return true;
    for (let end = size; end > head && Date.now() < deadline;) {
      const start = Math.max(head, end - chunkBytes);
      // Overlap the next (earlier) chunk so a match split between them is found.
      // Read a little before the chunk too, so the match's line (and its marker) is in view.
      const from = Math.max(0, start - LINE_CONTEXT_BYTES);
      if (await rangeContains(handle, from, Math.min(end + target.length, size), target)) {
        return true;
      }
      end = start;
    }
    return false;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function rangeContains(
  handle: fs.promises.FileHandle,
  start: number,
  end: number,
  target: Buffer
): Promise<boolean> {
  if (end - start < target.length) return false;
  const buffer = Buffer.alloc(end - start);
  await handle.read(buffer, 0, buffer.length, start);
  for (let at = buffer.indexOf(target); at >= 0; at = buffer.indexOf(target, at + 1)) {
    if (onAnnouncementLine(buffer, at)) return true;
  }
  return false;
}

/** Whether the line holding `at` names an mcp_instructions_delta before it. */
function onAnnouncementLine(buffer: Buffer, at: number): boolean {
  const lineStart = buffer.lastIndexOf(0x0a, at) + 1;
  const marker = buffer.indexOf(ANNOUNCEMENT_MARKER, lineStart);
  return marker >= 0 && marker < at;
}
