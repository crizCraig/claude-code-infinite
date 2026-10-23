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
 * forwarded) while another request, in this ccc or another, saves. Saving,
 * reusing and evicting run under a lock file in the directory, so a reuse
 * cannot interleave with another process's eviction of the same file.
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
const LOCK_NAME = ".lock";
/** A lock older than this was left by a process that died holding it. */
const STALE_LOCK_MS = 30_000;
/** How long a save waits for the lock before giving up (no copy, no shortening). */
const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 10;
export class ToolOutputStore {
    dir;
    now;
    constructor(dir = path.join(getConfigDir(), "tool-outputs"), now = Date.now) {
        this.dir = dir;
        this.now = now;
    }
    /** Save `text` and return its path, or undefined when it could not be written. */
    save(text) {
        if (!this.privateDir())
            return undefined;
        const name = createHash("sha256").update(text).digest("hex").slice(0, 32);
        const file = path.join(this.dir, `${name}.txt`);
        return withLock(path.join(this.dir, LOCK_NAME), () => {
            if (isOurFile(file)) {
                touch(file, this.now());
                return file;
            }
            if (!writeAtomically(this.dir, file, text))
                return undefined;
            touch(file, this.now());
            this.evict();
            return file;
        });
    }
    /** The directory exists, is a real directory owned by this user, mode 700. */
    privateDir() {
        try {
            fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
            const stat = fs.lstatSync(this.dir);
            if (!stat.isDirectory() || !ownedByMe(stat))
                return false;
            if ((stat.mode & 0o777) !== 0o700)
                fs.chmodSync(this.dir, 0o700);
            return true;
        }
        catch {
            return false;
        }
    }
    /** Drop the oldest files not touched within PIN_MS until both limits hold. */
    evict() {
        const recent = this.now() - PIN_MS;
        const files = listFiles(this.dir).sort((a, b) => b.mtimeMs - a.mtimeMs);
        let bytes = 0;
        files.forEach((entry, i) => {
            bytes += entry.size;
            if (entry.mtimeMs < recent && (i >= MAX_FILES || bytes > MAX_BYTES))
                unlinkQuietly(entry.file);
        });
    }
}
/**
 * Run `fn` holding the directory's lock file (created exclusively; one left
 * by a dead process is taken over after STALE_LOCK_MS), or return undefined
 * when it stays held for LOCK_WAIT_MS. Synchronous: saves are rare, short,
 * and only on the safety-net path.
 */
function withLock(lock, fn) {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        try {
            fs.closeSync(fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT |
                fs.constants.O_EXCL | NO_FOLLOW, 0o600));
            break;
        }
        catch {
            if (staleLock(lock))
                unlinkQuietly(lock);
            else if (Date.now() >= deadline)
                return undefined;
            else
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
        }
    }
    try {
        return fn();
    }
    finally {
        unlinkQuietly(lock);
    }
}
function staleLock(lock) {
    try {
        return Date.now() - fs.lstatSync(lock).mtimeMs > STALE_LOCK_MS;
    }
    catch {
        return false;
    }
}
function listFiles(dir) {
    let names;
    try {
        names = fs.readdirSync(dir);
    }
    catch {
        return [];
    }
    return names.filter((name) => name.endsWith(".txt")).flatMap((name) => {
        const file = path.join(dir, name);
        try {
            const stat = fs.lstatSync(file);
            return stat.isFile() ? [{ file, size: stat.size, mtimeMs: stat.mtimeMs }] : [];
        }
        catch {
            return [];
        }
    });
}
function isOurFile(file) {
    try {
        const stat = fs.lstatSync(file);
        return stat.isFile() && ownedByMe(stat);
    }
    catch {
        return false;
    }
}
function touch(file, nowMs) {
    try {
        const now = new Date(nowMs);
        fs.utimesSync(file, now, now);
    }
    catch {
        // Only eviction depends on it.
    }
}
/** Write through an exclusive, unpredictable temporary file and rename it. */
function writeAtomically(dir, file, text) {
    const tmp = path.join(dir, `.${randomBytes(12).toString("hex")}.tmp`);
    try {
        const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
        try {
            fs.writeFileSync(fd, text);
        }
        finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
        return true;
    }
    catch {
        unlinkQuietly(tmp);
        return false;
    }
}
function ownedByMe(stat) {
    return typeof process.getuid !== "function" || stat.uid === process.getuid();
}
function unlinkQuietly(file) {
    try {
        fs.unlinkSync(file);
    }
    catch {
        // Already gone, or not ours to remove.
    }
}
//# sourceMappingURL=tool-output-store.js.map