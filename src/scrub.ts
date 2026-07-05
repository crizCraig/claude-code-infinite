/**
 * Continuous transcript scrubber
 * (plans/2026-07-05_PLAN_first_user_turn_nonblocking.md, "Transcript scrubbing").
 *
 * Injected notices are ephemeral timeline moments: they explain a delay as it
 * happens and are NOT wanted on resume/fork. Claude Code persists streamed
 * content to ~/.claude/projects/<project>/<session>.jsonl with no
 * don't-persist channel, so ccc scrubs the marker blocks back out:
 *
 * - Watcher (while the session runs): fs.watch on the project transcript dir;
 *   on change, scan only newly appended bytes per file (tracked offsets); a
 *   file we've never seen is scanned whole — pre-existing files at startup
 *   (the recency-guarded sweep may have skipped them) and the fork case,
 *   since forking copies history (notice included) into a fresh .jsonl.
 * - In-place, length-preserving patches: NO temp+rename while CC runs — a
 *   rename swaps the inode under CC's open append handle and loses subsequent
 *   lines. The affected line is re-serialized without the notice and padded
 *   with trailing spaces to the original byte length, then pwritten at the
 *   same offset. Only complete (newline-terminated) lines are touched — a
 *   tail line still being written is left for the next scan.
 * - Backstop sweeps (startup + after `claude` exits, when nothing is running):
 *   plain rewrite + atomic rename, which also drops padding and now-empty
 *   notice-only lines.
 *
 * CC writes one transcript line per assistant content block, so a scrubbed
 * notice line becomes an assistant message with an empty content array — CC
 * merges per-block lines by message id on resume, contributing zero blocks.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NOTICE_OPEN, exciseNoticeSpans } from "./notices.js";

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
 * Deep-remove notice content from a parsed transcript line. Dedicated notice
 * text blocks are removed from their array; text that merely CONTAINS the
 * marker span (e.g. CC merged adjacent text blocks) has the span excised.
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
        item.text.includes(NOTICE_OPEN)
      ) {
        changed = true;
        const cleaned = exciseNoticeSpans(item.text);
        if (cleaned.trim() === "") node.splice(i, 1);
        else item.text = cleaned;
      } else if (typeof item === "string" && item.includes(NOTICE_OPEN)) {
        node[i] = exciseNoticeSpans(item);
        changed = true;
      } else if (item && typeof item === "object") {
        changed = scrubObjectInPlace(item) || changed;
      }
    }
  } else if (node && typeof node === "object") {
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === "string" && value.includes(NOTICE_OPEN)) {
        node[key] = exciseNoticeSpans(value);
        changed = true;
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
  if (!line.includes(NOTICE_OPEN)) return null;
  let obj: any;
  try {
    obj = JSON.parse(line.toString("utf-8"));
  } catch {
    return null;
  }
  if (!scrubObjectInPlace(obj)) return null;
  const out = Buffer.from(JSON.stringify(obj), "utf-8");
  if (out.length > line.length) return null; // removal only shrinks; belt-and-braces
  return Buffer.concat([out, Buffer.alloc(line.length - out.length, 0x20)]);
}

/** An assistant line whose content the scrubber emptied (CC writes one line per block). */
function isEmptyAssistantShell(obj: any): boolean {
  return (
    obj?.type === "assistant" &&
    Array.isArray(obj?.message?.content) &&
    obj.message.content.length === 0
  );
}

/**
 * Sweep-mode rewrite of one line (rename is allowed, so length may change).
 * Returns the line to keep, or null to drop it (notice-only assistant lines,
 * including shells left behind by earlier in-place patches — identified by
 * their space padding, which only the in-place patcher produces).
 */
function scrubLineForRewrite(line: string): string | null {
  const hadPadding = / +$/.test(line);
  const trimmed = hadPadding ? line.replace(/ +$/, "") : line;
  if (!trimmed.includes(NOTICE_OPEN)) {
    if (!hadPadding) return line;
    try {
      if (isEmptyAssistantShell(JSON.parse(trimmed))) return null;
    } catch {
      /* not JSON — keep as-is */
    }
    return trimmed;
  }
  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  scrubObjectInPlace(obj);
  if (isEmptyAssistantShell(obj)) {
    return null; // the line held nothing but the notice block
  }
  return JSON.stringify(obj);
}

export interface ScrubberOptions {
  debug?: boolean;
}

export interface SweepOptions extends ScrubberOptions {
  /**
   * Skip files modified within this many ms. A recently-touched transcript is
   * likely being appended to by a concurrent ccc/claude session in the same
   * project — rewrite+rename would swap the inode under that session's open
   * append handle and silently lose the rest of its history.
   */
  skipRecentMs?: number;
}

export interface TranscriptScrubber {
  close(): void;
  /** Wait for any in-flight scans (test hook). */
  idle(): Promise<void>;
}

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

      const buf = Buffer.alloc(size - start);
      await fd.read(buf, 0, buf.length, start);

      // Only complete newline-terminated lines are safe to patch.
      const lastNewline = buf.lastIndexOf(0x0a);
      if (lastNewline === -1) return;

      let lineStart = 0;
      while (lineStart <= lastNewline) {
        const nl = buf.indexOf(0x0a, lineStart);
        const line = buf.subarray(lineStart, nl);
        const patched = scrubLineInPlace(line);
        if (patched) {
          await fd.write(patched, 0, patched.length, start + lineStart);
          if (opts.debug) {
            console.error(`[ccc scrub] patched notice out of ${name} @${start + lineStart}`);
          }
        }
        lineStart = nl + 1;
      }
      offsets.set(name, start + lastNewline + 1);
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

  // Scan pre-existing files from byte 0: the startup sweep skips
  // recently-modified transcripts (live-session guard), so a leftover notice
  // from a killed prior session may still be on disk. The in-place patch is
  // length-preserving and safe on live files, so a one-time full scan per
  // file is cheap and safe.
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".jsonl")) schedule(name);
    }
  } catch {
    /* dir gone */
  }

  const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
    if (filename) {
      if (filename.endsWith(".jsonl")) schedule(filename);
      return;
    }
    // Platform gave no filename: rescan everything we know plus new files.
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith(".jsonl")) schedule(name);
      }
    } catch {
      /* dir gone */
    }
  });
  watcher.on("error", () => {
    /* watcher death is backstopped by the exit/startup sweeps */
  });

  return {
    close: () => watcher.close(),
    idle: () =>
      inFlight === 0
        ? Promise.resolve()
        : new Promise((resolve) => idleResolvers.push(resolve)),
  };
}

/**
 * Backstop sweep: full rewrite + atomic rename of any transcript containing
 * the marker. Only safe when no session is appending to these files — run it
 * at ccc startup (before launching claude) and after claude exits. Also drops
 * the in-place patches' space padding. Returns the number of files rewritten.
 *
 * Pass `skipRecentMs` to leave recently-modified files alone: another live
 * session may hold an open append handle on them, and renaming under it loses
 * data. Skipped files still get scrubbed by the watcher's in-place patches
 * (which scan pre-existing files from byte 0 at startup) and by a later sweep
 * once they've gone quiet.
 */
export async function sweepTranscripts(
  dir: string,
  opts: SweepOptions = {}
): Promise<number> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return 0; // no transcript dir yet
  }

  let cleaned = 0;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const filePath = path.join(dir, name);
    if (opts.skipRecentMs) {
      try {
        const { mtimeMs } = await fsp.stat(filePath);
        if (Date.now() - mtimeMs < opts.skipRecentMs) {
          if (opts.debug) {
            console.error(`[ccc scrub] skipping recently-modified ${name} (may be live)`);
          }
          continue;
        }
      } catch {
        continue; // raced deletion
      }
    }
    let content: string;
    try {
      content = await fsp.readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    // Marker present, or space-padding from earlier in-place patches (a
    // compact-JSON line never legitimately ends with a literal space).
    const needsSweep =
      content.includes(NOTICE_OPEN) ||
      content.includes(" \n") ||
      content.endsWith(" ");
    if (!needsSweep) continue;

    const lines = content.split("\n");
    // A trailing "" element means the file ended with \n — preserve that.
    const endsWithNewline = lines[lines.length - 1] === "";
    if (endsWithNewline) lines.pop();

    const kept: string[] = [];
    for (const line of lines) {
      if (line.trim() === "") continue;
      const scrubbed = scrubLineForRewrite(line);
      if (scrubbed !== null) kept.push(scrubbed);
    }

    const output = kept.join("\n") + (endsWithNewline ? "\n" : "");
    const tmpPath = path.join(dir, `.${name}.ccc-scrub-tmp`);
    try {
      await fsp.writeFile(tmpPath, output);
      await fsp.rename(tmpPath, filePath);
      cleaned++;
      if (opts.debug) console.error(`[ccc scrub] swept notices from ${name}`);
    } catch (err: any) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      if (opts.debug) console.error(`[ccc scrub] sweep failed for ${name}: ${err?.message}`);
    }
  }
  return cleaned;
}
