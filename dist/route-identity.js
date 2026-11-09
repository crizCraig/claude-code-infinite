import { createHash } from "node:crypto";
import { stripSystemReminderText } from "./turns.js";
// Request messages are immutable snapshots. Weak keys retain no completed request.
// Route installation stores these digests, not the original megabytes of history.
const routeHashes = new WeakMap();
const stableHashes = new WeakMap();
const routeMediaFreeHashes = new WeakMap();
const stableMediaFreeHashes = new WeakMap();
const routePortableHashes = new WeakMap();
const stablePortableHashes = new WeakMap();
/** Hash each incoming message once, then reuse it across route candidates/checks. */
export function routeMessageHash(message) {
    return messageHash(message, false, "exact");
}
/** Stable prefixes span turns in which Claude can omit earlier thinking blocks. */
export function stablePrefixMessageHash(message) {
    return messageHash(message, stableShape(message), "exact");
}
/** The identities a prefix stores for the messages it stands for. */
export function prefixIdentity(messages, kind) {
    const exact = kind === "stable" ? stablePrefixMessageHash : routeMessageHash;
    return {
        originalPrefixHashes: messages.map(exact),
        originalMediaFreeHashes: messages.map((m) => mediaFreeHash(m, kind)),
        originalPortableHashes: messages.map((m) => portableHash(m, kind)),
    };
}
/**
 * Whether `message` still stands where a prefix's message stood: unchanged, or the same
 * apart from media Claude Code evicted. Past its media caps (count, and bytes in 2.1.310)
 * Claude Code evicts the oldest images and documents from its history: a tool result's
 * becomes a placeholder, a top-level one is dropped, an emptied message becomes the
 * placeholder. That counts only when the message has no media left, so an attachment
 * replaced by another never matches; a removed one is indistinguishable from eviction.
 * A newer Claude Code can also render the same history differently on resume (see
 * portableHash); with media evicted too, that matches as well.
 * Prefixes stored before media-free or portable hashes existed match exactly only.
 */
export function prefixMessageMatches(message, kind, exact, mediaFree, portable) {
    const hash = kind === "stable" ? stablePrefixMessageHash(message) : routeMessageHash(message);
    if (hash === exact)
        return true;
    if (carriesMedia(message.content))
        return false;
    return (mediaFree !== undefined && mediaFreeHash(message, kind) === mediaFree) ||
        (portable !== undefined && portableHash(message, kind) === portable);
}
/**
 * Whether `newer` carries everything `older` does: every message of `older` after the
 * system prompt (whose billing line changes per call), in place and unchanged apart from
 * media Claude Code evicted since (prefixMessageMatches). Past its media caps every new
 * screenshot evicts an old one, so an exact comparison would never hold there. About
 * 20 ms for a 25 MB history; each message is hashed once.
 */
export function extendsHistory(newer, older) {
    const a = newer.filter((message) => message.role !== "system");
    const b = older.filter((message) => message.role !== "system");
    return a.length >= b.length && b.every((message, i) => prefixMessageMatches(a[i], "route", routeMessageHash(message), mediaFreeMessageHash(message)));
}
/** A message's route identity without its media (Claude Code's eviction keeps it). */
export function mediaFreeMessageHash(message) {
    return mediaFreeHash(message, "route");
}
function mediaFreeHash(message, kind) {
    return messageHash(message, kind === "stable" && stableShape(message), "media-free");
}
/**
 * A media-free identity that also ignores how Claude Code renders unchanged history,
 * which differs between versions (2.1.302 -> 2.1.319 on 2026-11-09): a reminder inside
 * a tool result's text or in a block of its own, a tool result's text as a string or a
 * text block, a tool input value as the JSON string the model sent or parsed.
 */
function portableHash(message, kind) {
    return messageHash(message, kind === "stable" && stableShape(message), "portable");
}
function stableShape(message) {
    return message.role === "assistant" && Array.isArray(message.content);
}
function hashCache(stable, mode) {
    if (mode === "portable")
        return stable ? stablePortableHashes : routePortableHashes;
    if (mode === "media-free")
        return stable ? stableMediaFreeHashes : routeMediaFreeHashes;
    return stable ? stableHashes : routeHashes;
}
function messageHash(message, stable, mode) {
    const cache = hashCache(stable, mode);
    const cached = cache.get(message);
    if (cached !== undefined)
        return cached;
    let content = message.content;
    if (stable && Array.isArray(content)) {
        content = content.filter((part) => part?.type !== "thinking" && part?.type !== "redacted_thinking");
    }
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
    const reminded = normalizeReminders(blocks);
    const kept = mode === "exact" ? reminded : withoutMedia(reminded);
    const normalized = {
        ...message, content: stripBlockCache(mode === "portable" ? portableContent(kept) : kept),
    };
    const hash = createHash("sha256");
    updateCanonical(hash, normalized);
    const digest = hash.digest("hex");
    cache.set(message, digest);
    return digest;
}
/** Same transform for stored and incoming messages, including nested tool results. */
function normalizeReminders(content) {
    if (typeof content === "string")
        return stripSystemReminderText(content);
    if (!Array.isArray(content))
        return content;
    return content.map((part) => {
        if (typeof part === "string")
            return stripSystemReminderText(part);
        if (!part || typeof part !== "object")
            return part;
        if (part.type === "text" && typeof part.text === "string") {
            return { ...part, text: stripSystemReminderText(part.text) };
        }
        if (part.type === "tool_result") {
            return { ...part, content: normalizeReminders(part.content) };
        }
        return part;
    });
}
/**
 * Content with rendering choices canonicalized (portableHash): text blocks left empty by
 * reminder removal dropped, a tool result's string as one text block, and tool input
 * values that are JSON strings of an object or array parsed.
 */
function portableContent(content) {
    if (!Array.isArray(content))
        return content;
    return content.filter((part) => !isEmptyText(part)).map((part) => {
        if (!part || typeof part !== "object")
            return part;
        if (part.type === "tool_result") {
            const inner = typeof part.content === "string"
                ? [{ type: "text", text: part.content }] : part.content;
            return { ...part, content: portableContent(inner) };
        }
        if (part.type === "tool_use" && isPlainObject(part.input)) {
            return { ...part, input: parsedJsonValues(part.input) };
        }
        return part;
    });
}
function isEmptyText(part) {
    return typeof part === "string" ? part === "" :
        part?.type === "text" && part.text === "" && Object.keys(part).length === 2;
}
function parsedJsonValues(input) {
    const out = {};
    for (const [key, value] of Object.entries(input))
        out[key] = parsedJson(value);
    return out;
}
/** A string holding a JSON object or array, parsed; any other value as it is. */
function parsedJson(value) {
    if (typeof value !== "string" || !/^\s*[[{]/.test(value))
        return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" ? parsed : value;
    }
    catch {
        return value;
    }
}
function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
/**
 * Claude Code's stand-ins for media it removed from its own history. After the API
 * rejects media it removes a message left empty altogether; that shifts positions and
 * still breaks a prefix (rare, and a recompress follows).
 */
const MEDIA_PLACEHOLDERS = new Set([
    "[media removed: request limit]", "(media removed \u2014 rejected by API)",
]);
/** Content without media blocks and without Claude Code's placeholders for them. */
function withoutMedia(content) {
    if (!Array.isArray(content))
        return content;
    return content.filter((part) => !isMediaOrPlaceholder(part)).map((part) => part && typeof part === "object" && part.type === "tool_result"
        ? { ...part, content: withoutMedia(part.content) }
        : part);
}
/** Whether any image or document is left, at the top level or in a tool result. */
function carriesMedia(content) {
    if (!Array.isArray(content))
        return false;
    return content.some((part) => part?.type === "image" || part?.type === "document" ||
        (part?.type === "tool_result" && carriesMedia(part.content)));
}
function isMediaOrPlaceholder(part) {
    if (!part || typeof part !== "object")
        return false;
    if (part.type === "image" || part.type === "document")
        return true;
    return part.type === "text" && MEDIA_PLACEHOLDERS.has(part.text);
}
/** Cache metadata on blocks is incidental; identically named tool input keys aren't. */
function stripBlockCache(content) {
    if (Array.isArray(content))
        return content.map(stripBlockCache);
    if (!content || typeof content !== "object")
        return content;
    const { cache_control: _ignored, ...block } = content;
    return block;
}
/**
 * Typed, length-framed canonical encoding avoids serializing large strings twice.
 * UTF-16 preserves lone surrogates too; UTF-8 would equate them with U+FFFD.
 * This is a process-local identity digest, not a wire-format hash.
 */
function updateCanonical(hash, value) {
    if (value === null || value === undefined) {
        hash.update("n");
    }
    else if (typeof value === "string") {
        hash.update(`s${value.length}:`).update(value, "utf16le");
    }
    else if (typeof value === "number") {
        hash.update(Number.isFinite(value) ? `d${String(value)};` : "n");
    }
    else if (typeof value === "boolean") {
        hash.update(value ? "t" : "f");
    }
    else if (Array.isArray(value)) {
        hash.update(`a${value.length}:`);
        for (const item of value)
            updateCanonical(hash, item);
    }
    else if (typeof value === "object") {
        const object = value;
        const keys = Object.keys(object).filter((key) => object[key] !== undefined).sort();
        hash.update(`o${keys.length}:`);
        for (const key of keys) {
            updateCanonical(hash, key);
            updateCanonical(hash, object[key]);
        }
    }
    else {
        throw new TypeError("Route identity requires JSON message data");
    }
}
//# sourceMappingURL=route-identity.js.map