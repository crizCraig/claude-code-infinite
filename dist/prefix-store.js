/**
 * Each Claude Code session's adopted compressed prefix (ProxyState
 * .stablePrefixes), kept on disk so a resumed session's first turn rides it
 * instead of blocking on a fresh compress: a new ccc process starts with no
 * prefix, and a large session's compress can outrun its budget.
 *
 * One file per session and owner under ~/.claude-code-infinite/
 * stable-prefixes/. The owner is MemtreeClient.storageIdentity, a hash over the
 * MemTree origin and a hash of the key (never the key): an entry, and the
 * memory-source page in it, is only ever read back for the same backend and
 * account, so a staging/production or key switch never adopts it.
 *
 * Files are mode 600 in a 700 directory owned by this user, written through an
 * exclusive, unpredictably named temporary file and a rename, and opened
 * without following symlinks. The total size and the number of sessions are
 * bounded, the oldest saves are evicted first, and stale temporary files are
 * removed. An entry holds only what reproduces the prefix byte for byte (the
 * compressed messages and system, the identity of the raw prefix they replace)
 * plus the target and window it was built for and its memory-source page. It
 * is schema-checked on load and, by the proxy, validated against the request
 * exactly like the in-memory prefix before adoption. Every failure is
 * swallowed (a missing prefix only costs a compress); contents are never
 * logged.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { getConfigDir } from "./config.js";
const ENTRY_VERSION = 2;
export const STABLE_PREFIX_STORE_LIMITS = {
    maxBytes: 256 * 1024 * 1024,
    maxEntries: 64,
};
/** A temporary file this old belongs to a failed or killed write. */
const STALE_TEMP_MS = 60_000;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
export class StablePrefixStore {
    dir;
    limits;
    constructor(dir = path.join(getConfigDir(), "stable-prefixes"), limits = STABLE_PREFIX_STORE_LIMITS) {
        this.dir = dir;
        this.limits = limits;
    }
    /** The session's entry for `owner`; an unreadable or invalid one is deleted. */
    load(sessionId, owner) {
        if (!this.privateDir(false))
            return undefined;
        const text = readPrivateFile(this.entryPath(sessionId, owner), this.limits.maxBytes);
        if (text === undefined)
            return undefined;
        const entry = parseEntry(text);
        if (entry?.sessionId === sessionId && entry.owner === owner)
            return entry;
        this.delete(sessionId, owner);
        return undefined;
    }
    /** Replace the session's entry, then evict down to the limits. */
    save(sessionId, owner, prefix, source, now = Date.now()) {
        if (!this.privateDir(true))
            return;
        const entry = {
            version: ENTRY_VERSION, sessionId, owner, savedAt: now, prefix,
            ...(source ? { source } : {}),
        };
        if (!isEntry(entry))
            return;
        const file = this.entryPath(sessionId, owner);
        if (writeAtomically(this.dir, file, JSON.stringify(entry)))
            this.evict(now);
    }
    delete(sessionId, owner) {
        unlinkQuietly(this.entryPath(sessionId, owner));
    }
    /** Where the entry for this session and owner lives. */
    entryPath(sessionId, owner) {
        const name = createHash("sha256").update(`${owner}\0${sessionId}`).digest("hex");
        return path.join(this.dir, `${name.slice(0, 40)}.json`);
    }
    /**
     * The directory exists (created when `create`), is a real directory (not a
     * symlink) owned by this user, and is mode 700 (repaired when it is not).
     */
    privateDir(create) {
        try {
            if (create)
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
    /** Drop stale temporaries, then the oldest saves until the limits fit. */
    evict(now) {
        const { entries, pendingBytes } = this.scan(now);
        entries.sort((a, b) => b.savedAt - a.savedAt);
        let bytes = pendingBytes;
        entries.forEach((entry, i) => {
            bytes += entry.bytes;
            if (i >= this.limits.maxEntries || bytes > this.limits.maxBytes)
                unlinkQuietly(entry.file);
        });
    }
    /**
     * Entry files with size and save time. Symlinks and stale temporaries are
     * removed; recent temporaries (writes in progress) count toward the size.
     */
    scan(now) {
        const entries = [];
        let pendingBytes = 0;
        for (const name of safeReaddir(this.dir)) {
            const file = path.join(this.dir, name);
            const stat = safeLstat(file);
            if (!stat)
                continue;
            if (stat.isSymbolicLink()) {
                unlinkQuietly(file);
            }
            else if (!stat.isFile()) {
                continue;
            }
            else if (name.endsWith(".tmp")) {
                if (now - stat.mtimeMs >= STALE_TEMP_MS)
                    unlinkQuietly(file);
                else
                    pendingBytes += stat.size;
            }
            else if (name.endsWith(".json")) {
                entries.push({ file, bytes: stat.size, savedAt: savedAtOf(file, stat.mtimeMs) });
            }
        }
        return { entries, pendingBytes };
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
/** A regular file of ours, opened without following a symlink; mode repaired to 600. */
function readPrivateFile(file, maxBytes) {
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
    }
    catch {
        return undefined;
    }
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || !ownedByMe(stat) || stat.size > maxBytes)
            return undefined;
        if ((stat.mode & 0o777) !== 0o600)
            fs.fchmodSync(fd, 0o600);
        return fs.readFileSync(fd, "utf-8");
    }
    catch {
        return undefined;
    }
    finally {
        fs.closeSync(fd);
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
        // Already gone.
    }
}
function safeReaddir(dir) {
    try {
        return fs.readdirSync(dir);
    }
    catch {
        return [];
    }
}
function safeLstat(file) {
    try {
        return fs.lstatSync(file);
    }
    catch {
        return undefined;
    }
}
/**
 * An entry's savedAt, read from its head without parsing the whole (possibly
 * multi-MB) file; the file mtime when the head does not say.
 */
function savedAtOf(file, mtimeMs) {
    try {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
        try {
            const head = Buffer.alloc(512);
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
    return isObject(v) && v.version === ENTRY_VERSION &&
        typeof v.sessionId === "string" && nonEmptyString(v.owner) &&
        Number.isFinite(v.savedAt) && isPrefix(v.prefix) &&
        (v.source === undefined || isPageSource(v.source));
}
/** The prefix's invariants: the identity of a covered history, and well-formed bytes. */
function isPrefix(p) {
    return isObject(p) && nonEmptyString(p.originalSystemHash) &&
        Array.isArray(p.originalPrefixHashes) && p.originalPrefixHashes.length > 0 &&
        p.originalPrefixHashes.every(nonEmptyString) &&
        Array.isArray(p.compressedMessages) && p.compressedMessages.length > 0 &&
        p.compressedMessages.every(isMessage) &&
        typeof p.hasCompressedSystem === "boolean" &&
        (p.hasCompressedSystem ? isSystem(p.compressedSystem) : p.compressedSystem == null) &&
        positiveNumber(p.targetTokens) && typeof p.explicitTarget === "boolean" &&
        Number.isInteger(p.modelContextLimit) && p.modelContextLimit > 0;
}
/** An Anthropic message: user/assistant role, string or typed-block content. */
function isMessage(m) {
    const message = m;
    return isObject(message) && (message.role === "user" || message.role === "assistant") &&
        (typeof message.content === "string" || isBlockList(message.content));
}
/** A top-level system prompt: a string or typed blocks. */
function isSystem(system) {
    return typeof system === "string" || isBlockList(system);
}
function isBlockList(value) {
    return Array.isArray(value) && value.length > 0 && value.every(isBlock);
}
/**
 * A content block of a type a compressed prefix can carry, with that type's
 * required fields. Anything else (an unknown type, a missing field) fails, so
 * the entry is deleted and the session rebuilds instead of sending a body
 * Anthropic rejects.
 */
function isBlock(value) {
    if (!isObject(value))
        return false;
    const block = value;
    if (block.cache_control !== undefined && !isObject(block.cache_control))
        return false;
    const check = BLOCK_CHECKS[block.type];
    return typeof block.type === "string" && check !== undefined && check(block);
}
const BLOCK_CHECKS = {
    text: (b) => typeof b.text === "string",
    image: (b) => isSource(b.source, IMAGE_SOURCES),
    document: (b) => isSource(b.source, DOCUMENT_SOURCES),
    tool_use: (b) => nonEmptyString(b.id) && nonEmptyString(b.name) && isObject(b.input),
    tool_result: (b) => nonEmptyString(b.tool_use_id) &&
        (b.content === undefined || typeof b.content === "string" || isBlockList(b.content)) &&
        (b.is_error === undefined || typeof b.is_error === "boolean"),
    thinking: (b) => typeof b.thinking === "string" && typeof b.signature === "string",
    redacted_thinking: (b) => nonEmptyString(b.data),
};
/** Source kinds and their required string fields. */
const IMAGE_SOURCES = {
    base64: ["media_type", "data"], url: ["url"], file: ["file_id"],
};
const DOCUMENT_SOURCES = {
    ...IMAGE_SOURCES, text: ["media_type", "data"],
};
function isSource(value, kinds) {
    if (!isObject(value))
        return false;
    const source = value;
    const fields = typeof source.type === "string" ? kinds[source.type] : undefined;
    return fields !== undefined && fields.every((field) => nonEmptyString(source[field]));
}
function isPageSource(s) {
    return isObject(s) && typeof s.url === "string" && /^https?:\/\//.test(s.url) &&
        nonEmptyString(s.index) && typeof s.compressed === "boolean";
}
function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function nonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}
function positiveNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}
//# sourceMappingURL=prefix-store.js.map