/**
 * Delta uploads (message refs): messages MemTree already stores are named by hash instead
 * of being uploaded again.
 *
 * Every MemTree call sends the whole conversation (~11.7 GB/week in 2026-10; one
 * image-heavy agent lane alone uploaded 6.7 GB). A server with delta uploads on answers
 * each call that declares `message-refs` with `memtree_message_refs`: once the request is
 * in its conversation store, every item the call sent may be named next time by the hash
 * of its hashing form, except the `unservable` ones (rows holding a redacted secret) and
 * messages holding an image in `unserved_images`. The server puts the named messages back
 * before reading the request, so billing, hashing and indexing are those of a full upload.
 * Anything it cannot serve answers 409 `missing_message_hashes`; the call is then sent
 * again in full. Contract and golden vectors: polychat docs/memtree_delta_upload.md and
 * polychat/conversation_store_delta_vectors.json (test/fixtures/delta_vectors.json).
 *
 * Off unless CCC_MEMTREE_DELTA=1 (the client half of polychat's CONVERSATION_STORE_DELTA).
 */
import { createHash } from "node:crypto";
import { isCanonicalBase64 } from "./image-refs.js";
import { stripCcSystemReminders } from "./turns.js";
/** Declared in x-client-features: this client sends refs and reads STORED_MESSAGES_FIELD. */
export const MESSAGE_REFS_FEATURE = "message-refs";
/** Answer field: whether the request is stored, and what may not be named. */
export const STORED_MESSAGES_FIELD = "memtree_message_refs";
/** 409 detail field: the refs the server could not serve. */
export const MISSING_MESSAGES_FIELD = "missing_message_hashes";
export const MISSING_MESSAGES_STATUS = 409;
export const REF_KEY = "memtree_ref";
const MARKS_KEY = "cache_marks";
const HEADER_KEY = "billing_header";
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header";
/** Sessions whose acks are remembered, and hashes per session (memory bound). */
const SESSIONS_MAX = 32;
const ACKED_PER_SESSION_MAX = 200_000;
/** 409s in one session before it goes back to full uploads for the process. */
const SESSION_MISSES_MAX = 3;
const HEX_RE = /^[0-9a-f]{64}$/;
export class MessageRefs {
    enabled;
    acked = new Map();
    misses = new Map();
    off = new Set();
    disabled = false;
    constructor(enabled) {
        this.enabled = enabled;
    }
    /** `messages` with every acked message after the opening as a ref (none: the same list). */
    delta(sessionId, messages) {
        const acked = sessionId ? this.ackedFor(sessionId) : undefined;
        if (!acked || acked.size === 0)
            return { messages, refs: [] };
        return buildDelta(messages, acked);
    }
    /** Learn what an answer to a call that sent `messages` (in full) lets the next one name. */
    noteAnswer(sessionId, messages, json) {
        if (!this.enabled || this.disabled || !sessionId)
            return;
        const field = json?.[STORED_MESSAGES_FIELD];
        if (field === undefined) {
            // A server that takes no refs (off, or never had them): name nothing until it does.
            this.acked.delete(sessionId);
            return;
        }
        const acks = field;
        if (!acks || acks.stored !== true || acks.messages !== messages.length)
            return;
        this.remember(sessionId, ackedDigests(messages, acks));
    }
    /**
     * A refusal of a call that named `refs` (hex): true when the call should go again in
     * full. A 409 forgets what it names; one naming every ref, or the session's
     * SESSION_MISSES_MAX-th, ends refs for the session; a 400 about refs ends them all.
     */
    noteRefusal(sessionId, refs, status, bodyText) {
        if (!sessionId || refs.length === 0)
            return false;
        if (status === 400 && /message refs/i.test(bodyText)) {
            this.disabled = true;
            this.acked.clear();
            return true;
        }
        const missing = status === MISSING_MESSAGES_STATUS ? missingMessageHashes(bodyText) : undefined;
        if (missing === undefined)
            return false;
        const misses = (this.misses.get(sessionId) ?? 0) + 1;
        this.misses.set(sessionId, misses);
        const all = refs.every((ref) => missing.includes(ref));
        if (all || misses >= SESSION_MISSES_MAX) {
            this.off.add(sessionId);
            this.acked.delete(sessionId);
        }
        else {
            const acked = this.acked.get(sessionId);
            for (const hash of missing)
                acked?.delete(hash);
        }
        return true;
    }
    ackedFor(sessionId) {
        if (!this.enabled || this.disabled || this.off.has(sessionId))
            return undefined;
        return this.acked.get(sessionId);
    }
    remember(sessionId, digests) {
        if (this.off.has(sessionId))
            return;
        let set = this.acked.get(sessionId);
        if (set)
            this.acked.delete(sessionId);
        else
            set = new Set();
        this.acked.set(sessionId, set);
        for (const digest of digests)
            set.add(digest);
        while (set.size > ACKED_PER_SESSION_MAX) {
            const first = set.values().next().value;
            if (first === undefined)
                break;
            set.delete(first);
        }
        while (this.acked.size > SESSIONS_MAX) {
            const oldest = this.acked.keys().next().value;
            if (oldest === undefined)
                break;
            this.acked.delete(oldest);
        }
    }
}
/**
 * The reference client of the contract: acked messages as refs, except the opening (the
 * first message that is not system/developer and not only <system-reminder> blocks) and
 * everything before it that is not a system/developer message.
 */
export function buildDelta(messages, acked) {
    const opening = messages.findIndex(isOpening);
    if (opening < 0)
        return { messages, refs: [] };
    let headerSeen = false;
    const refs = [];
    const out = messages.map((message, index) => {
        const eligible = index > opening || isSkipped(message);
        const ref = eligible ? refFor(message, !headerSeen) : undefined;
        headerSeen = headerSeen || billingHeaderOf(message) !== undefined;
        if (!ref || !acked.has(ref.digest))
            return message;
        refs.push(ref.digest);
        return refJson(ref);
    });
    return refs.length ? { messages: out, refs } : { messages, refs: [] };
}
/**
 * A message's ref as the server's store hashes it: sha256 of the compact JSON of the
 * message without its `cache_control` keys and, when `stripHeader` (no earlier message of
 * the request had one), without a system message's leading billing-header block.
 */
export function refFor(message, stripHeader = true) {
    if (!message || typeof message !== "object" || Array.isArray(message))
        return undefined;
    const header = stripHeader ? billingHeaderOf(message) : undefined;
    const form = header === undefined ? message
        : { ...message, content: message.content.slice(1) };
    const marks = [];
    const stripped = withoutCacheControl(form, [], marks);
    return { digest: hashOf(stripped), marks, ...(header !== undefined ? { header } : {}) };
}
/** The digests an answer's acks allow for `messages`, in the request's header order. */
export function ackedDigests(messages, acks) {
    const unservable = new Set(stringsOf(acks.unservable));
    const images = new Set(stringsOf(acks.unserved_images));
    const out = [];
    let headerSeen = false;
    for (const message of messages) {
        const ref = refFor(message, !headerSeen);
        headerSeen = headerSeen || billingHeaderOf(message) !== undefined;
        if (!ref || unservable.has(ref.digest))
            continue;
        if (images.size && imageShas(message).some((sha) => images.has(sha)))
            continue;
        out.push(ref.digest);
    }
    return out;
}
/** The hashes a 409 names, or undefined when it names none. */
export function missingMessageHashes(bodyText) {
    try {
        const listed = JSON.parse(bodyText)?.detail?.[MISSING_MESSAGES_FIELD];
        if (!Array.isArray(listed))
            return undefined;
        return listed.filter((hash) => typeof hash === "string" && HEX_RE.test(hash));
    }
    catch {
        return undefined;
    }
}
// --------------------------------------------------------------------------- leaves
function refJson(ref) {
    return {
        [REF_KEY]: ref.digest,
        ...(ref.marks.length ? { [MARKS_KEY]: ref.marks } : {}),
        ...(ref.header !== undefined ? { [HEADER_KEY]: ref.header } : {}),
    };
}
function hashOf(value) {
    return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
function billingHeaderOf(message) {
    if (message?.role !== "system" || !Array.isArray(message.content))
        return undefined;
    const first = message.content[0];
    return first?.type === "text" && typeof first.text === "string" &&
        first.text.startsWith(BILLING_HEADER_PREFIX) ? first : undefined;
}
/** A copy without `cache_control` keys; each removal as [path, key position, value]. */
function withoutCacheControl(value, path, marks) {
    if (Array.isArray(value)) {
        const out = value.map((item, i) => withoutCacheControl(item, [...path, i], marks));
        return out.every((item, i) => item === value[i]) ? value : out;
    }
    if (!value || typeof value !== "object")
        return value;
    const entries = Object.entries(value);
    const out = {};
    let changed = false;
    entries.forEach(([key, item], position) => {
        if (key === "cache_control") {
            marks.push([path, position, item]);
            changed = true;
            return;
        }
        const next = withoutCacheControl(item, [...path, key], marks);
        if (next !== item)
            changed = true;
        out[key] = next;
    });
    return changed ? out : value;
}
function isOpening(message) {
    return !isSkipped(message) && stripCcSystemReminders([message]).length > 0;
}
function isSkipped(message) {
    return message?.role === "system" || message?.role === "developer";
}
/** Shas of the message's canonical base64 images (the ones the server stores). */
function imageShas(value, out = []) {
    if (Array.isArray(value)) {
        for (const item of value)
            imageShas(item, out);
    }
    else if (value && typeof value === "object") {
        const block = value;
        const data = block.type === "image" ? block.source?.data : undefined;
        if (block.source?.type === "base64" && typeof data === "string" && isCanonicalBase64(data)) {
            out.push(createHash("sha256").update(Buffer.from(data, "base64")).digest("hex"));
            return out;
        }
        for (const item of Object.values(block))
            imageShas(item, out);
    }
    return out;
}
function stringsOf(value) {
    return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}
//# sourceMappingURL=message-refs.js.map