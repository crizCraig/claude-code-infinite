/**
 * Continuous transcript scrubber
 * (plans/2026-07-05_PLAN_first_user_turn_nonblocking.md, "Transcript scrubbing").
 *
 * Current notices use display-only hooks and never enter transcripts. Older
 * releases injected marker-wrapped assistant content, which is NOT wanted on
 * resume/fork and could also be copied into an `away_summary`. This legacy
 * scrubber removes those leftovers from ~/.claude/projects/... JSONL files:
 *
 * - Watcher: fs.watch on the project transcript dir; on change, scan only
 *   newly appended bytes per file (tracked offsets); a file we've never seen
 *   is scanned whole — pre-existing files at startup (a killed prior session
 *   may have left a notice on disk) and the fork case, since forking copies
 *   history (notice included) into a fresh .jsonl.
 * - Live notices are held until the transcript records `turn_duration`. CC
 *   writes a notice content-block line before the real assistant content for
 *   that same message; removing it immediately can make CC's final render see
 *   an empty block and erase the notice before the user can read it. The
 *   turn-duration record is the deterministic end-of-turn gate. Startup
 *   leftovers are scrubbed only through the EOF captured before watching, and
 *   flush() force-scrubs any final notice after the child exits.
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
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  NOTICE_OPEN,
  containsNoticeSpan,
  exciseKnownLegacyNoticeSpans,
} from "./notices.js";

const SCRUBBER_LOCK_PREFIX = ".ccc-scrubber-";
const ACTIVE_SCRUBBER_LOCK_PREFIX = `${SCRUBBER_LOCK_PREFIX}active-`;
const EXITING_SCRUBBER_LOCK_PREFIX = `${SCRUBBER_LOCK_PREFIX}exiting-`;

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/**
 * Count cooperating ccc scrubbers whose children may still be rendering,
 * pruning locks whose owning process is gone. An `exiting` lock means flush
 * has begun only after that child exited, so its transcript is safe to clean.
 * An active lock we cannot read is conservatively considered live.
 */
function activeScrubberCount(dir: string): number {
  let count = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return count;
  }
  for (const name of names) {
    if (!name.startsWith(SCRUBBER_LOCK_PREFIX) || !name.endsWith(".lock")) continue;
    const lockPath = path.join(dir, name);
    try {
      const data = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      if (!processIsAlive(data?.pid)) {
        fs.rmSync(lockPath, { force: true });
      } else if (name.startsWith(ACTIVE_SCRUBBER_LOCK_PREFIX)) {
        count++;
      }
    } catch {
      if (name.startsWith(ACTIVE_SCRUBBER_LOCK_PREFIX)) count++;
    }
  }
  return count;
}

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
 * Remove known legacy notices only from assistant content text. Never recurse
 * into tool_use input or other structured fields: those can legitimately hold
 * marker examples and are replay-critical state.
 */
function scrubAssistantContentInPlace(node: any): boolean {
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
        exciseKnownLegacyNoticeSpans(item.text) !== item.text
      ) {
        const cleaned = exciseKnownLegacyNoticeSpans(item.text);
        if (cleaned !== item.text) {
          changed = true;
          if (cleaned.trim() === "") node.splice(i, 1);
          else item.text = cleaned;
        }
      } else if (
        typeof item === "string" &&
        exciseKnownLegacyNoticeSpans(item) !== item
      ) {
        const cleaned = exciseKnownLegacyNoticeSpans(item);
        if (cleaned !== item) {
          node[i] = cleaned;
          changed = true;
        }
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
  // Ordinary user quotes are never rewritten. Besides the original assistant
  // injection shape, clean the specific system metadata shape produced when a
  // hidden recap summarized a legacy notice into its away_summary content.
  let changed = false;
  if (obj?.type === "assistant") {
    const content = obj.message?.content;
    if (typeof content === "string") {
      const cleaned = exciseKnownLegacyNoticeSpans(content);
      if (cleaned !== content) {
        obj.message.content = cleaned;
        changed = true;
      }
    } else {
      changed = scrubAssistantContentInPlace(content);
    }
  } else if (
    obj?.type === "system" &&
    obj?.subtype === "away_summary" &&
    typeof obj.content === "string" &&
    exciseKnownLegacyNoticeSpans(obj.content) !== obj.content
  ) {
    obj.content = exciseKnownLegacyNoticeSpans(obj.content);
    changed = true;
  }
  if (!changed) return null;
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
  /** Scan current appends normally and wait for all scans (test hook). */
  idle(): Promise<void>;
}

/**
 * Scan window size. Bounded so the startup byte-0 scans of a project's whole
 * transcript history never buffer entire files — peak memory per scan is one
 * window plus the longest carried line.
 */
const SCAN_CHUNK_SIZE = 1 << 20; // 1 MiB
const CURSOR_FINGERPRINT_SIZE = 256;

/**
 * Watch a project transcript dir and scrub notices from appended lines after
 * their turn completes (macOS FSEvents supplies the append notifications).
 */
export function startTranscriptScrubber(
  dir: string,
  opts: ScrubberOptions = {}
): TranscriptScrubber {
  fs.mkdirSync(dir, { recursive: true });

  // Cross-process coordination is needed only for the two force-cleanup
  // paths. Normal completion-gated pwrite scans are safe to run concurrently.
  // Unique names let multiple scrubbers in one process coordinate in tests
  // and in embedding applications too.
  const lockId = `${process.pid}-${randomUUID()}.lock`;
  let ownLockPath: string | null = path.join(
    dir,
    `${ACTIVE_SCRUBBER_LOCK_PREFIX}${lockId}`
  );
  try {
    fs.writeFileSync(ownLockPath, JSON.stringify({ pid: process.pid }), {
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    ownLockPath = null;
  }

  function markOwnLockExiting(): boolean {
    if (ownLockPath === null) return false;
    if (path.basename(ownLockPath).startsWith(EXITING_SCRUBBER_LOCK_PREFIX)) {
      return true;
    }
    const exitingPath = path.join(dir, `${EXITING_SCRUBBER_LOCK_PREFIX}${lockId}`);
    try {
      // Same-directory rename is atomic: peers see either active or exiting,
      // never a partially-written state that could make both defer cleanup.
      fs.renameSync(ownLockPath, exitingPath);
      ownLockPath = exitingPath;
      return true;
    } catch {
      return false;
    }
  }

  interface FileCursor {
    /** Byte offset of the first unscanned line. */
    offset: number;
    dev: number;
    ino: number;
    /** Bytes immediately before offset, used to detect same-inode rewrites. */
    fingerprint: Buffer;
  }

  /** Unknown file ⇒ byte zero (new transcript / fork case). */
  const cursors = new Map<string, FileCursor>();
  /** Last model-input prompt id seen while scanning each transcript. */
  const promptIds = new Map<string, string>();

  interface PendingNotice {
    offset: number;
    length: number;
    promptId?: string;
  }

  /** Notice lines seen in live appends, waiting for a later turn_duration. */
  const pendingNotices = new Map<string, PendingNotice[]>();

  const scanning = new Set<string>();
  const rescan = new Set<string>();
  /** Optional byte boundary through which a scan may scrub without a completion gate. */
  const forceThrough = new Map<string, number>();
  let inFlight = 0;
  let idleResolvers: Array<() => void> = [];

  function isTurnDurationLine(line: Buffer): boolean {
    if (!line.includes('"turn_duration"')) return false;
    try {
      const obj = JSON.parse(line.toString("utf-8"));
      return obj?.type === "system" && obj?.subtype === "turn_duration";
    } catch {
      return false;
    }
  }

  function humanPromptId(line: Buffer): string | null {
    if (!line.includes('"type":"user"') || !line.includes('"promptId"')) {
      return null;
    }
    try {
      const obj = JSON.parse(line.toString("utf-8"));
      const content = obj?.message?.content;
      const isToolResult =
        Array.isArray(content) &&
        content.some((part) => part?.type === "tool_result");
      // A prompt id on a non-tool-result user record identifies a model-input
      // turn (typed text/image prompt, recap, or steering message).
      return obj?.type === "user" &&
        typeof obj?.promptId === "string" &&
        (typeof content === "string" || (Array.isArray(content) && !isToolResult))
        ? obj.promptId
        : null;
    } catch {
      return null;
    }
  }

  function rememberPending(name: string, offset: number, length: number): void {
    const entries = pendingNotices.get(name) ?? [];
    // Offsets advance monotonically in an append-only transcript. The guard is
    // for a watcher rescan racing an offset update or another scrubber process.
    if (!entries.some((entry) => entry.offset === offset)) {
      entries.push({ offset, length, promptId: promptIds.get(name) });
      pendingNotices.set(name, entries);
    }
  }

  async function patchPending(
    fd: fsp.FileHandle,
    name: string,
    beforeOffset = Number.POSITIVE_INFINITY,
    activePromptId?: string
  ): Promise<void> {
    const entries = pendingNotices.get(name);
    if (!entries?.length) return;

    const remaining: PendingNotice[] = [];
    for (const entry of entries) {
      // Include the newline in the boundary check. A line that was only
      // partially present at startup is live data even if its start offset was
      // inside the captured EOF.
      if (entry.offset + entry.length + 1 > beforeOffset) {
        remaining.push(entry);
        continue;
      }
      // A later, different prompt id proves copied history belongs to a prior
      // turn even when an old/forked transcript omitted turn_duration. The
      // same prompt id may be an in-turn steering message, so keep waiting.
      if (
        activePromptId !== undefined &&
        (entry.promptId === undefined || entry.promptId === activePromptId)
      ) {
        remaining.push(entry);
        continue;
      }

      // Re-read at patch time: another ccc process may already have scrubbed
      // this line, and retaining an old buffer would overwrite its patch.
      const current = Buffer.alloc(entry.length);
      const { bytesRead } = await fd.read(
        current,
        0,
        current.length,
        entry.offset
      );
      if (bytesRead !== current.length) {
        // A raced truncate/replacement will be rediscovered from byte zero.
        remaining.push(entry);
        continue;
      }
      const patched = scrubLineInPlace(current);
      if (patched) {
        await fd.write(patched, 0, patched.length, entry.offset);
        if (opts.debug) {
          console.error(`[ccc scrub] patched completed notice out of ${name} @${entry.offset}`);
        }
      }
      // No marker means another in-place scrubber got there first; either way
      // this pending entry is complete and must not be retried forever.
    }

    if (remaining.length) pendingNotices.set(name, remaining);
    else pendingNotices.delete(name);
  }

  async function readFingerprint(
    fd: fsp.FileHandle,
    offset: number
  ): Promise<Buffer> {
    const length = Math.min(CURSOR_FINGERPRINT_SIZE, offset);
    if (length === 0) return Buffer.alloc(0);
    const out = Buffer.alloc(length);
    const { bytesRead } = await fd.read(out, 0, length, offset - length);
    return bytesRead === length ? out : out.subarray(0, bytesRead);
  }

  async function saveCursor(
    fd: fsp.FileHandle,
    name: string,
    offset: number,
    stat: fs.Stats
  ): Promise<void> {
    cursors.set(name, {
      offset,
      dev: stat.dev,
      ino: stat.ino,
      fingerprint: await readFingerprint(fd, offset),
    });
  }

  async function cursorIsValid(
    fd: fsp.FileHandle,
    cursor: FileCursor,
    size: number,
    stat: fs.Stats
  ): Promise<boolean> {
    if (stat.dev !== cursor.dev || stat.ino !== cursor.ino || size < cursor.offset) {
      return false;
    }
    if (cursor.fingerprint.length === 0) return true;
    const current = Buffer.alloc(cursor.fingerprint.length);
    const { bytesRead } = await fd.read(
      current,
      0,
      current.length,
      cursor.offset - current.length
    );
    return bytesRead === current.length && current.equals(cursor.fingerprint);
  }

  function resetFileState(name: string): void {
    cursors.delete(name);
    pendingNotices.delete(name);
    promptIds.delete(name);
  }

  async function scanFile(name: string, forcedTo?: number): Promise<void> {
    const filePath = path.join(dir, name);
    let fd: fsp.FileHandle;
    try {
      fd = await fsp.open(filePath, "r+");
    } catch {
      return; // deleted or unreadable
    }
    try {
      const stat = await fd.stat();
      const size = stat.size;
      let cursor = cursors.get(name);
      if (cursor && !(await cursorIsValid(fd, cursor, size, stat))) {
        // Atomic replacement changes inode; truncate+rewrite on the same inode
        // changes the boundary fingerprint even when the new file is larger.
        resetFileState(name);
        cursor = undefined;
      }
      const start = cursor?.offset ?? 0;
      if (size <= start) {
        if (forcedTo !== undefined) await patchPending(fd, name, forcedTo);
        await saveCursor(fd, name, start, stat);
        return;
      }

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
          const lineOffset = bufBase + lineStart;
          const lineEnd = bufBase + nl + 1;

          const nextPromptId = humanPromptId(line);
          if (nextPromptId !== null) {
            await patchPending(fd, name, lineOffset, nextPromptId);
            promptIds.set(name, nextPromptId);
          }

          if (line.includes(NOTICE_OPEN)) {
            if (forcedTo !== undefined && lineEnd <= forcedTo) {
              const patched = scrubLineInPlace(line);
              if (patched) {
                await fd.write(patched, 0, patched.length, lineOffset);
                if (opts.debug) {
                  console.error(`[ccc scrub] patched stale notice out of ${name} @${lineOffset}`);
                }
              }
            } else if (containsNoticeSpan(line.toString("utf-8"))) {
              rememberPending(name, lineOffset, line.length);
            }
          }

          // A duration line is appended only after CC has persisted and
          // rendered the turn's final assistant content. Every earlier pending
          // notice in this transcript is now safe to remove.
          if (isTurnDurationLine(line)) {
            await patchPending(fd, name, lineOffset);
          }
          lineStart = nl + 1;
        }
        scannedTo = bufBase + lineStart;
        if (lineStart < buf.length) {
          carry = Buffer.from(buf.subarray(lineStart)); // copy — chunk is reused
        }
      }
      if (forcedTo !== undefined) await patchPending(fd, name, forcedTo);
      await saveCursor(fd, name, scannedTo, stat);
    } catch (err: any) {
      if (opts.debug) console.error(`[ccc scrub] scan failed for ${name}: ${err?.message}`);
    } finally {
      await fd.close().catch(() => {});
    }
  }

  function schedule(name: string, forcedTo?: number): void {
    if (forcedTo !== undefined) {
      forceThrough.set(
        name,
        Math.max(forceThrough.get(name) ?? Number.NEGATIVE_INFINITY, forcedTo)
      );
    }
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
          const thisForce = forceThrough.get(name);
          forceThrough.delete(name);
          await scanFile(name, thisForce);
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

  function captureEofs(): Map<string, number> {
    const captured = new Map<string, number>();
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        try {
          captured.set(name, fs.statSync(path.join(dir, name)).size);
        } catch {
          /* raced deletion */
        }
      }
    } catch {
      /* dir gone */
    }
    return captured;
  }

  function scheduleCaptured(captured: Map<string, number>): void {
    for (const [name, eof] of captured) schedule(name, eof);
  }

  /**
   * Deterministic final cleanup after children exit. The watcher scheduler can
   * receive a late fs event just as waitForIdle resolves; force-scanning these
   * captured files directly from byte zero makes flush completion independent
   * of that event ordering.
   */
  async function forceCapturedNow(captured: Map<string, number>): Promise<void> {
    await waitForIdle();
    for (const [name, eof] of captured) {
      resetFileState(name);
      await scanFile(name, eof);
    }
    await waitForIdle();
  }

  function waitForIdle(): Promise<void> {
    return inFlight === 0
      ? Promise.resolve()
      : new Promise((resolve) => idleResolvers.push(resolve));
  }

  // Install the watcher before baseline enumeration, then reconcile once more
  // afterward. This closes the create/append gap between readdir and fs.watch.
  const watcher = fs.watch(dir, { persistent: false }, (event, filename) => {
    if (filename && filename.endsWith(".jsonl")) {
      if (event === "rename") resetFileState(filename);
      schedule(filename);
    } else if (!filename) {
      // Platform gave no filename: rescan everything we know plus new files.
      scheduleAll();
    }
  });
  watcher.on("error", () => {
    /* watcher death leaves any later notices until the next launch's byte-0 scan */
  });

  const mayForceStartup = (): boolean =>
    ownLockPath !== null && activeScrubberCount(dir) === 1;

  // Capture each pre-existing EOF before scanning. A killed prior session may
  // have left a notice there, but anything appended after this point belongs
  // to a live turn and must wait for its duration record. Never force a
  // baseline while another ccc scrubber is alive in this project: its current
  // notice is complete JSON too, but its turn may still be rendering.
  const startupEofs = captureEofs();
  if (mayForceStartup()) scheduleCaptured(startupEofs);
  else scheduleAll();
  scheduleAll(); // reconcile files created while the baseline was enumerated

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    watcher.close();
    if (ownLockPath !== null) {
      try {
        fs.rmSync(ownLockPath, { force: true });
      } catch {
        /* a stale pid lock is pruned by the next scrubber */
      }
      ownLockPath = null;
    }
  }

  return {
    close,
    flush: async () => {
      // The child has exited, so a final turn that never wrote turn_duration
      // is complete as far as this ccc process is concerned. Project-wide
      // force is safe only when no other ccc scrubber has a live child here.
      // Capture EOFs *before* checking locks: a new scrubber that locks later
      // can append only beyond these boundaries, while an existing scrubber's
      // lock is included in the following count. Atomically mark our child as
      // exited before counting: if peers exit concurrently, at least the last
      // active→exiting transition observes zero active children and performs
      // the cleanup; simultaneous force scans are also safe because they
      // re-read and pwrite identical length-preserving patches.
      const finalEofs = captureEofs();
      const markedExiting = markOwnLockExiting();
      let didForce = false;
      if (markedExiting && activeScrubberCount(dir) === 0) {
        await forceCapturedNow(finalEofs);
        didForce = true;
      } else {
        scheduleAll();
        await waitForIdle();
      }

      // Cross-process exits can interleave after our first synchronous count:
      // a peer that was still active may have transitioned to exiting while
      // our normal scan ran. Recheck once at quiescence so every simultaneous
      // exit has a chance to become the final cleanup owner. The captured EOF
      // still protects any newer live session's appends.
      if (!didForce && markedExiting && activeScrubberCount(dir) === 0) {
        await forceCapturedNow(finalEofs);
      }
    },
    idle: () => {
      scheduleAll();
      return waitForIdle();
    },
  };
}
