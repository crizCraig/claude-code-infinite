/**
 * Continuous transcript scrubber
 * (plans/2026-07-05_PLAN_first_user_turn_nonblocking.md, "Transcript scrubbing").
 *
 * Injected notices are ephemeral timeline moments: they explain a delay as it
 * happens and are NOT wanted on resume/fork. Claude Code persists streamed
 * content to ~/.claude/projects/<project>/<session>.jsonl with no
 * don't-persist channel, so ccc scrubs the marker blocks back out:
 *
 * - Watcher: fs.watch on the project transcript dir; on change, scan only
 *   newly appended bytes per file (tracked offsets); a file we've never seen
 *   is scanned whole — pre-existing files at startup (a killed prior session
 *   may have left a notice on disk) and the fork case, since forking copies
 *   history (notice included) into a fresh .jsonl.
 * - In-place, length-preserving patches only: NEVER temp+rename — a rename
 *   swaps the inode under a session's open append handle and loses subsequent
 *   lines, and there is no reliable way to tell whether some other session
 *   holds a handle (mtime quietness isn't proof; an idle session can resume
 *   appending at any time). The affected line is re-serialized without the
 *   notice and padded with trailing spaces to the original byte length, then
 *   pwritten at the same offset. Only complete (newline-terminated) lines are
 *   touched — a tail line still being written is left for the next scan.
 *
 * The leftovers are harmless: padded lines parse fine, and CC writes one
 * transcript line per assistant content block, so a scrubbed notice line
 * becomes an assistant message with an empty content array — CC merges
 * per-block lines by message id on resume, contributing zero blocks.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NOTICE_OPEN, containsNoticeSpan, exciseNoticeSpans } from "./notices.js";

/** Claude Code's transcript dir for a working directory (path munged to dashes). */
export function projectTranscriptDir(cwd: string): string {
  // CC munges the symlink-resolved path (verified 2026-07-05 on cc 2.1.201:
  // /var/folders/... sessions land under -private-var-folders-...).
  let resolved = cwd;
  try {
    resolved = fs.realpathSync(cwd);
  } catch {
    /* keep as given */
  }
  const munged = resolved.replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", munged);
}

/**
 * Deep-remove notice content from a parsed assistant message. Dedicated notice
 * text blocks are removed from their array; text that merely CONTAINS the
 * marker span (e.g. CC merged adjacent text blocks) has the span excised.
 * Only complete spans count — a bare open tag is left alone — and `changed`
 * reflects actual mutation, so an untouched line is never reported dirty.
 */
function scrubObjectInPlace(node: any): boolean {
  let changed = false;
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) {
      const item = node[i];
      if (
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        item.type === "text" &&
        typeof item.text === "string" &&
        containsNoticeSpan(item.text)
      ) {
        const cleaned = exciseNoticeSpans(item.text);
        if (cleaned !== item.text) {
          changed = true;
          if (cleaned.trim() === "") node.splice(i, 1);
          else item.text = cleaned;
        }
      } else if (typeof item === "string" && containsNoticeSpan(item)) {
        const cleaned = exciseNoticeSpans(item);
        if (cleaned !== item) {
          node[i] = cleaned;
          changed = true;
        }
      } else if (item && typeof item === "object") {
        changed = scrubObjectInPlace(item) || changed;
      }
    }
  } else if (node && typeof node === "object") {
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === "string" && containsNoticeSpan(value)) {
        const cleaned = exciseNoticeSpans(value);
        if (cleaned !== value) {
          node[key] = cleaned;
          changed = true;
        }
      } else if (value && typeof value === "object") {
        changed = scrubObjectInPlace(value) || changed;
      }
    }
  }
  return changed;
}

/**
 * Length-preserving patch for one complete line (no trailing newline):
 * re-serialized JSON without the notice, space-padded to the original byte
 * length. Returns null when there's nothing to patch (or the line can't be
 * safely patched — unparseable, or the result wouldn't fit).
 */
export function scrubLineInPlace(line: Buffer): Buffer | null {
  if (!line.includes(NOTICE_OPEN)) return null; // cheap pre-filter for the common case
  const text = line.toString("utf-8");
  if (!containsNoticeSpan(text)) return null; // bare open tag — nothing excisable
  let obj: any;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  // Only assistant lines carry injected notices; a user message quoting the
  // marker is never rewritten (mirrors stripNoticeBlocks' request-path rule).
  if (obj?.type !== "assistant") return null;
  if (!scrubObjectInPlace(obj.message)) return null;
  const out = Buffer.from(JSON.stringify(obj), "utf-8");
  if (out.length > line.length) return null; // removal only shrinks; belt-and-braces
  return Buffer.concat([out, Buffer.alloc(line.length - out.length, 0x20)]);
}

export interface ScrubberOptions {
  debug?: boolean;
}

export interface TranscriptScrubber {
  close(): void;
  /**
   * Scan any not-yet-scanned appends across all transcripts now and wait for
   * the scans to finish (tracked offsets make this cheap). Used as the final
   * pass after `claude` exits, when the last turn's notice may have just
   * landed. Never rejects — scan errors are swallowed (the next launch's
   * byte-0 scan is the backstop).
   */
  flush(): Promise<void>;
  /** Wait for any in-flight scans (test hook). */
  idle(): Promise<void>;
}

/**
 * Scan window size. Bounded so the startup byte-0 scans of a project's whole
 * transcript history never buffer entire files — peak memory per scan is one
 * window plus the longest carried line.
 */
const SCAN_CHUNK_SIZE = 1 << 20; // 1 MiB

/**
 * Watch a project transcript dir and scrub notices from appended lines as
 * they land (macOS FSEvents — near-instant; on-disk notice lifetime ~ms).
 */
export function startTranscriptScrubber(
  dir: string,
  opts: ScrubberOptions = {}
): TranscriptScrubber {
  fs.mkdirSync(dir, { recursive: true });

  /** name → byte offset of the first unscanned line. Unknown file ⇒ 0 (fork case). */
  const offsets = new Map<string, number>();

  const scanning = new Set<string>();
  const rescan = new Set<string>();
  let inFlight = 0;
  let idleResolvers: Array<() => void> = [];

  async function scanFile(name: string): Promise<void> {
    const filePath = path.join(dir, name);
    let fd: fsp.FileHandle;
    try {
      fd = await fsp.open(filePath, "r+");
    } catch {
      return; // deleted or unreadable
    }
    try {
      const size = (await fd.stat()).size;
      let start = offsets.get(name) ?? 0;
      if (size < start) start = 0; // truncated/replaced — rescan from the top
      if (size <= start) return;

      // Read in bounded windows; a line straddling a window boundary is
      // carried into the next read so it's still patched as a whole.
      const chunk = Buffer.alloc(Math.min(SCAN_CHUNK_SIZE, size - start));
      let carry: Buffer | null = null;
      let pos = start; // next file offset to read
      let scannedTo = start; // first byte of the earliest incomplete line
      while (pos < size) {
        const { bytesRead } = await fd.read(
          chunk,
          0,
          Math.min(chunk.length, size - pos),
          pos
        );
        if (bytesRead <= 0) break; // raced truncation
        const bufBase = pos - (carry?.length ?? 0); // file offset of buf[0]
        const buf: Buffer = carry
          ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
          : chunk.subarray(0, bytesRead);
        carry = null;
        pos += bytesRead;

        // Only complete newline-terminated lines are safe to patch.
        let lineStart = 0;
        let nl: number;
        while ((nl = buf.indexOf(0x0a, lineStart)) !== -1) {
          const line = buf.subarray(lineStart, nl);
          const patched = scrubLineInPlace(line);
          if (patched) {
            await fd.write(patched, 0, patched.length, bufBase + lineStart);
            if (opts.debug) {
              console.error(`[ccc scrub] patched notice out of ${name} @${bufBase + lineStart}`);
            }
          }
          lineStart = nl + 1;
        }
        scannedTo = bufBase + lineStart;
        if (lineStart < buf.length) {
          carry = Buffer.from(buf.subarray(lineStart)); // copy — chunk is reused
        }
      }
      offsets.set(name, scannedTo);
    } catch (err: any) {
      if (opts.debug) console.error(`[ccc scrub] scan failed for ${name}: ${err?.message}`);
    } finally {
      await fd.close().catch(() => {});
    }
  }

  function schedule(name: string): void {
    if (scanning.has(name)) {
      rescan.add(name);
      return;
    }
    scanning.add(name);
    inFlight++;
    void (async () => {
      try {
        do {
          rescan.delete(name);
          await scanFile(name);
        } while (rescan.has(name));
      } finally {
        scanning.delete(name);
        if (--inFlight === 0) {
          const resolvers = idleResolvers;
          idleResolvers = [];
          for (const resolve of resolvers) resolve();
        }
      }
    })();
  }

  function scheduleAll(): void {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith(".jsonl")) schedule(name);
      }
    } catch {
      /* dir gone */
    }
  }

  function idle(): Promise<void> {
    return inFlight === 0
      ? Promise.resolve()
      : new Promise((resolve) => idleResolvers.push(resolve));
  }

  // Scan pre-existing files from byte 0: a killed prior session may have left
  // a notice on disk. The in-place patch is length-preserving and safe on
  // live files, so a one-time full scan per file is cheap and safe.
  scheduleAll();

  const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
    if (filename && filename.endsWith(".jsonl")) {
      schedule(filename);
    } else if (!filename) {
      // Platform gave no filename: rescan everything we know plus new files.
      scheduleAll();
    }
  });
  watcher.on("error", () => {
    /* watcher death leaves any later notices until the next launch's byte-0 scan */
  });

  return {
    close: () => watcher.close(),
    flush: () => {
      scheduleAll();
      return idle();
    },
    idle,
  };
}

