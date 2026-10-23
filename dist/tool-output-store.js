/**
 * Full copies of tool results the proxy shortened to fit the context window
 * (tool-result-truncation.ts), so the model can read the omitted part
 * verbatim with Claude Code's own Read or Grep tools.
 *
 * One file per distinct output under ~/.claude-code-infinite/tool-outputs/,
 * named by its content hash (the same output always gets the same path, so a
 * repeated truncation sends the same bytes), mode 600 in a private mode-700
 * directory, at most MAX_FILES files and MAX_BYTES bytes (oldest dropped).
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "./config.js";
const MAX_FILES = 64;
const MAX_BYTES = 512 * 1024 * 1024;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
export class ToolOutputStore {
    dir;
    constructor(dir = path.join(getConfigDir(), "tool-outputs")) {
        this.dir = dir;
    }
    /**
     * Save `text` and return its path, or undefined when it could not be written.
     * Eviction never removes a path in `keep` (the other copies one shortened
     * request points at).
     */
    save(text, keep = new Set()) {
        if (!this.privateDir())
            return undefined;
        const name = createHash("sha256").update(text).digest("hex").slice(0, 32);
        const file = path.join(this.dir, `${name}.txt`);
        if (isOurFile(file)) {
            touch(file);
            return file;
        }
        if (!writeAtomically(this.dir, file, text))
            return undefined;
        this.evict(new Set([...keep, file]));
        return file;
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
    /** Drop the oldest files (never one in `keep`) until both limits hold. */
    evict(keep) {
        const files = listFiles(this.dir).sort((a, b) => Number(keep.has(b.file)) - Number(keep.has(a.file)) || b.mtimeMs - a.mtimeMs);
        let bytes = 0;
        files.forEach((entry, i) => {
            bytes += entry.size;
            if (!keep.has(entry.file) && (i >= MAX_FILES || bytes > MAX_BYTES))
                unlinkQuietly(entry.file);
        });
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
function touch(file) {
    try {
        const now = new Date();
        fs.utimesSync(file, now, now);
    }
    catch {
        // Only eviction order depends on it.
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