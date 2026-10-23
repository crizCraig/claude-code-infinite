/**
 * Full copies of tool results the proxy shortened to fit the context window
 * (tool-result-truncation.ts), so the model can read the omitted part
 * verbatim with Claude Code's own Read or Grep tools.
 *
 * One file per distinct output and half hour under
 * ~/.claude-code-infinite/tool-outputs/, named by its content hash and the
 * half hour it was first needed (within a half hour the same output gets the
 * same path, so a repeated truncation sends the same bytes), mode 600 in a
 * private mode-700 directory, at most MAX_FILES files and MAX_BYTES bytes.
 *
 * No lock is needed between ccc processes: a path is only ever returned while
 * its file is under BUCKET_MS old, and eviction only removes files over
 * EVICT_AFTER_MS old, so a path handed out is never removed while the request
 * that points at it is on its way. Rewriting the same name writes the same
 * bytes (an atomic rename), so concurrent saves agree.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "./config.js";

const MAX_FILES = 64;
const MAX_BYTES = 512 * 1024 * 1024;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
/** A copy is reused only within the half hour its name carries. */
const BUCKET_MS = 30 * 60 * 1000;
/** Only copies older than this (twice a bucket) are ever evicted. */
const EVICT_AFTER_MS = 2 * BUCKET_MS;

export class ToolOutputStore {
  constructor(
    readonly dir: string = path.join(getConfigDir(), "tool-outputs"),
    private readonly now: () => number = Date.now,
  ) {}

  /** Save `text` and return its path, or undefined when it could not be written. */
  save(text: string): string | undefined {
    if (!this.privateDir()) return undefined;
    const name = createHash("sha256").update(text).digest("hex").slice(0, 32);
    const bucket = Math.floor(this.now() / BUCKET_MS);
    const file = path.join(this.dir, `${name}-${bucket}.txt`);
    if (isOurFile(file)) return file;
    if (!writeAtomically(this.dir, file, text)) return undefined;
    stamp(file, this.now());
    this.evict();
    return file;
  }

  /** The directory exists, is a real directory owned by this user, mode 700. */
  private privateDir(): boolean {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(this.dir);
      if (!stat.isDirectory() || !ownedByMe(stat)) return false;
      if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(this.dir, 0o700);
      return true;
    } catch {
      return false;
    }
  }

  /** Drop the oldest files over EVICT_AFTER_MS old until both limits hold. */
  private evict(): void {
    const old = this.now() - EVICT_AFTER_MS;
    const files = listFiles(this.dir).sort((a, b) => b.mtimeMs - a.mtimeMs);
    let bytes = 0;
    files.forEach((entry, i) => {
      bytes += entry.size;
      if (entry.mtimeMs < old && (i >= MAX_FILES || bytes > MAX_BYTES)) unlinkQuietly(entry.file);
    });
  }
}

function listFiles(dir: string): Array<{ file: string; size: number; mtimeMs: number }> {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith(".txt")).flatMap((name) => {
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      return stat.isFile() ? [{ file, size: stat.size, mtimeMs: stat.mtimeMs }] : [];
    } catch {
      return [];
    }
  });
}

function isOurFile(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && ownedByMe(stat);
  } catch {
    return false;
  }
}

/** Set a new copy's mtime to the store's clock (its age for eviction). */
function stamp(file: string, nowMs: number): void {
  try {
    const now = new Date(nowMs);
    fs.utimesSync(file, now, now);
  } catch {
    // Its real mtime is close enough.
  }
}

/** Write through an exclusive, unpredictable temporary file and rename it. */
function writeAtomically(dir: string, file: string, text: string): boolean {
  const tmp = path.join(dir, `.${randomBytes(12).toString("hex")}.tmp`);
  try {
    const fd = fs.openSync(tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, text);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return true;
  } catch {
    unlinkQuietly(tmp);
    return false;
  }
}

function ownedByMe(stat: fs.Stats): boolean {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function unlinkQuietly(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone, or not ours to remove.
  }
}
