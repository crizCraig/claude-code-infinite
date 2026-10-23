/**
 * Full copies of tool results the proxy shortened to fit the context window
 * (tool-result-truncation.ts), so the model can read the omitted part
 * verbatim with Claude Code's own Read or Grep tools.
 *
 * One file per distinct output under ~/.claude-code-infinite/tool-outputs/,
 * named by its content hash (the same output always gets the same path, so a
 * repeated truncation sends the same bytes), mode 600 in a private mode-700
 * directory, at most MAX_FILES files and MAX_BYTES bytes (oldest dropped),
 * except that a copy saved or reused within PIN_MS (its mtime) is never
 * dropped: the request pointing at it may still be on its way (counted,
 * forwarded) while another request, in this ccc or another, saves.
 *
 * No lock: copies are content-addressed, so any process may write the same
 * bytes again. Eviction first renames a file aside and re-checks its mtime
 * there, restoring it when a reuse touched it meanwhile; a reuse touches,
 * then confirms the file is still in place, and writes it again if not.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "./config.js";

const MAX_FILES = 64;
const MAX_BYTES = 512 * 1024 * 1024;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
/** How long a copy saved or reused (its mtime) is protected from eviction. */
const PIN_MS = 60 * 60 * 1000;

export class ToolOutputStore {
  constructor(
    readonly dir: string = path.join(getConfigDir(), "tool-outputs"),
    private readonly now: () => number = Date.now,
  ) {}

  /** Save `text` and return its path, or undefined when it could not be written. */
  save(text: string): string | undefined {
    if (!this.privateDir()) return undefined;
    const name = createHash("sha256").update(text).digest("hex").slice(0, 32);
    const file = path.join(this.dir, `${name}.txt`);
    if (isOurFile(file) && touch(file, this.now()) && isOurFile(file)) return file;
    if (!writeAtomically(this.dir, file, text)) return undefined;
    touch(file, this.now());
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

  /** Drop the oldest files not touched within PIN_MS until both limits hold. */
  private evict(): void {
    const recent = this.now() - PIN_MS;
    const files = listFiles(this.dir).sort((a, b) => b.mtimeMs - a.mtimeMs);
    let bytes = 0;
    files.forEach((entry, i) => {
      bytes += entry.size;
      if (entry.mtimeMs < recent && (i >= MAX_FILES || bytes > MAX_BYTES)) {
        this.evictOne(entry.file, recent);
      }
    });
  }

  /**
   * Remove `file` unless it was touched since `recent`: renamed aside first,
   * so a reuse that touched it before the rename is seen there (and the file
   * put back) and one after it finds the file gone and writes it again.
   */
  private evictOne(file: string, recent: number): void {
    const aside = path.join(this.dir, `.${randomBytes(12).toString("hex")}.evict`);
    try {
      fs.renameSync(file, aside);
    } catch {
      return;
    }
    try {
      if (fs.lstatSync(aside).mtimeMs >= recent) fs.linkSync(aside, file);
    } catch {
      // Already back (a reuse wrote it again), or gone: either way it is safe.
    }
    unlinkQuietly(aside);
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

/** Set `file`'s mtime to `nowMs`; false when it is not there to touch. */
function touch(file: string, nowMs: number): boolean {
  try {
    const now = new Date(nowMs);
    fs.utimesSync(file, now, now);
    return true;
  } catch {
    return false;
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
