/**
 * Each Claude Code session's adopted compressed prefix (ProxyState
 * .stablePrefixes), kept on disk so a resumed session's first turn rides it
 * instead of blocking on a fresh compress: a new ccc process starts with no
 * prefix, and a large session's compress can outrun its budget.
 *
 * One file per session under ~/.claude-code-infinite/stable-prefixes/, named
 * by a hash of the session id, mode 600, written whole through a temporary
 * file and a rename. The total size and the number of sessions are bounded;
 * the oldest saves are evicted first. An entry holds only what reproduces the
 * prefix byte for byte: the compressed messages and system, and the identity
 * of the raw prefix they replace (system hash, per-message hashes), plus the
 * target and window it was built for and the page its memory came from. The
 * proxy validates an entry exactly as it validates the in-memory prefix
 * before adopting it. Every failure is swallowed (a missing prefix only costs
 * a compress), and contents are never logged.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getConfigDir } from "./config.js";
const ENTRY_VERSION = 1;
export const STABLE_PREFIX_STORE_LIMITS = {
    maxBytes: 256 * 1024 * 1024,
    maxEntries: 64,
};
export class StablePrefixStore {
    dir;
    limits;
    constructor(dir = path.join(getConfigDir(), "stable-prefixes"), limits = STABLE_PREFIX_STORE_LIMITS) {
        this.dir = dir;
        this.limits = limits;
    }
    /** The session's entry; a corrupt or foreign one is deleted (undefined). */
    load(sessionId) {
        const file = this.fileFor(sessionId);
        let text;
        try {
            text = fs.readFileSync(file, "utf-8");
        }
        catch {
            return undefined;
        }
        const entry = parseEntry(text);
        if (entry?.sessionId === sessionId)
            return entry;
        this.delete(sessionId);
        return undefined;
    }
    /** Replace the session's entry, then evict down to the limits. */
    save(sessionId, prefix, source, now = Date.now()) {
        try {
            const entry = {
                version: ENTRY_VERSION, sessionId, savedAt: now, prefix,
                ...(source ? { source } : {}),
            };
            fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
            const file = this.fileFor(sessionId);
            const tmp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
            fs.renameSync(tmp, file);
            this.evict();
        }
        catch {
            // A lost prefix only costs a compress on the next resume.
        }
    }
    delete(sessionId) {
        try {
            fs.unlinkSync(this.fileFor(sessionId));
        }
        catch {
            // Already gone.
        }
    }
    /** Drop the oldest saves until the entry count and total size fit. */
    evict() {
        const entries = this.listEntries().sort((a, b) => b.savedAt - a.savedAt);
        let bytes = 0;
        entries.forEach((entry, i) => {
            bytes += entry.bytes;
            if (i >= this.limits.maxEntries || bytes > this.limits.maxBytes) {
                try {
                    fs.unlinkSync(entry.file);
                }
                catch { /* already gone */ }
            }
        });
    }
    /** Entry files with their size and save time (file mtime). */
    listEntries() {
        const found = [];
        for (const name of fs.readdirSync(this.dir)) {
            if (!name.endsWith(".json"))
                continue;
            const file = path.join(this.dir, name);
            try {
                const stat = fs.statSync(file);
                found.push({ file, bytes: stat.size, savedAt: savedAtOf(file, stat.mtimeMs) });
            }
            catch {
                // Removed concurrently.
            }
        }
        return found;
    }
    fileFor(sessionId) {
        const name = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
        return path.join(this.dir, `${name}.json`);
    }
}
/**
 * An entry's savedAt, read from its head without parsing the whole (possibly
 * multi-MB) file; the file mtime when the head does not say.
 */
function savedAtOf(file, mtimeMs) {
    try {
        const fd = fs.openSync(file, "r");
        try {
            const head = Buffer.alloc(256);
            const n = fs.readSync(fd, head, 0, head.length, 0);
            const match = /"savedAt":(\d+)/.exec(head.subarray(0, n).toString("utf-8"));
            return match ? Number(match[1]) : mtimeMs;
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch {
        return mtimeMs;
    }
}
function parseEntry(text) {
    try {
        const entry = JSON.parse(text);
        return isEntry(entry) ? entry : undefined;
    }
    catch {
        return undefined;
    }
}
function isEntry(v) {
    return !!v && typeof v === "object" && v.version === ENTRY_VERSION &&
        typeof v.sessionId === "string" && typeof v.savedAt === "number" &&
        isPrefix(v.prefix) && (v.source === undefined || isSource(v.source));
}
function isPrefix(p) {
    return !!p && typeof p === "object" && typeof p.originalSystemHash === "string" &&
        Array.isArray(p.originalPrefixHashes) &&
        p.originalPrefixHashes.every((h) => typeof h === "string") &&
        Array.isArray(p.compressedMessages) && p.compressedMessages.length > 0 &&
        typeof p.hasCompressedSystem === "boolean" &&
        Number.isFinite(p.targetTokens) && typeof p.explicitTarget === "boolean" &&
        Number.isFinite(p.modelContextLimit);
}
function isSource(s) {
    return !!s && typeof s === "object" && typeof s.url === "string" &&
        /^https?:\/\//.test(s.url) && typeof s.index === "string" &&
        typeof s.compressed === "boolean";
}
//# sourceMappingURL=prefix-store.js.map