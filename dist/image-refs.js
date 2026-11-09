/**
 * Image references on MemTree calls: images MemTree already stores are not uploaded again.
 *
 * Every index and compress call sends the whole conversation, so a screenshot-heavy
 * session re-sent every image as base64 on every call (2026-10: 8.7, 12.5 and 18.5 MB
 * bodies for 194k-384k tokens of context), heading for the 32 MiB HTTP/1 limit. A
 * server that resolves references lists, on each answer, the request's images it
 * stores (`memtree_image_sha256s`); later calls send those images as their block with
 * `source.data` replaced by IMAGE_REF_PREFIX + the sha256 of the image bytes, and the
 * server puts the bytes back before reading the request, so hashing, billing and what
 * it returns are unchanged. Only the MemTree upload changes: what ccc forwards to
 * Anthropic never carries a reference. Servers that never list stored images (older
 * ones, or with the image store off) only ever get bytes.
 */
import { createHash } from "node:crypto";
export const IMAGE_REF_PREFIX = "memtree-image:sha256:";
/** Declared in x-client-features: this client reads STORED_IMAGES_FIELD. */
export const IMAGE_REFS_FEATURE = "image-refs";
/** Answer field: shas of the request's images the server stores. */
export const STORED_IMAGES_FIELD = "memtree_image_sha256s";
/** 409 detail field: references the server could not serve. */
export const MISSING_IMAGES_FIELD = "missing_image_sha256s";
/** The server's answer to references it cannot serve; the call is sent again with bytes. */
export const MISSING_IMAGES_STATUS = 409;
/** Stored shas remembered (a 1M-token window holds ~600 images). */
const KNOWN_MAX = 4096;
/** Reference blocks one call may carry unconfirmed (the server's MAX_IMAGE_REFS). */
export const MAX_UNCONFIRMED_REFS = 1000;
/** Base64 strings whose sha is remembered, by total length (memory bound). */
const SHA_CACHE_MAX_CHARS = 64 * 1024 * 1024;
const SHA_HEX_RE = /^[0-9a-f]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
export class ImageRefs {
    known = new Map();
    /** Shas the server said it lacks, until an answer lists them (bounded like known). */
    lacking = new Map();
    shaOf = new Map();
    shaChars = 0;
    disabled = false;
    /** Whether calls may carry references at all (the server listed stored images). */
    get active() {
        return !this.disabled && this.known.size > 0;
    }
    /** Learn the stored images an answer lists; a server that lists none changes nothing. */
    noteAnswer(json) {
        const listed = json?.[STORED_IMAGES_FIELD];
        if (!Array.isArray(listed))
            return;
        for (const sha of listed) {
            if (typeof sha !== "string" || !SHA_HEX_RE.test(sha))
                continue;
            this.known.delete(sha);
            this.known.set(sha, true);
            this.lacking.delete(sha);
        }
        dropOldest(this.known, KNOWN_MAX);
    }
    /** Whether an answer shows a server that resolves references (it lists stored images). */
    static resolvedBy(json) {
        return Array.isArray(json?.[STORED_IMAGES_FIELD]);
    }
    /** The server lacks these: they are not referenced unconfirmed again. */
    noteMissing(shas) {
        for (const sha of shas)
            this.lacking.set(sha, true);
        dropOldest(this.lacking, KNOWN_MAX);
    }
    /** The server could not serve these (or, without a list, any): send bytes for them. */
    forget(shas) {
        for (const sha of shas)
            this.known.delete(sha);
    }
    /**
     * Forget what the server lacked: its bytes did not fit, and a lack can be a slow
     * read on the server (its read deadline) that the next attempt no longer hits.
     */
    retryMissing() {
        this.lacking.clear();
    }
    /** The server refused references outright (an older or misconfigured server). */
    disable() {
        this.disabled = true;
        this.known.clear();
        this.lacking.clear();
    }
    /** `messages` with each stored image as a reference; copy on write. */
    referenceMessages(messages) {
        if (!this.active)
            return { value: messages, refs: [] };
        return this.referenceAll(messages, (sha) => this.known.has(sha));
    }
    /**
     * `messages` with every image as a reference unless the server said it lacks it, up
     * to MAX_UNCONFIRMED_REFS: for a body that cannot be sent with its images' bytes, in
     * a process that has no answer listing stored images yet (a resumed session). The
     * server names the ones it lacks (409) and the caller sends those as bytes.
     */
    referenceUnconfirmed(messages) {
        if (this.disabled)
            return { value: messages, refs: [] };
        let left = MAX_UNCONFIRMED_REFS;
        return this.referenceAll(messages, (sha) => !this.lacking.has(sha) && left-- > 0);
    }
    /** One message with each stored image as a reference; the same object if none is. */
    referenceMessage(message) {
        if (!this.active)
            return { value: message, refs: [] };
        return this.referenceOne(message, (sha) => this.known.has(sha));
    }
    referenceAll(messages, wanted) {
        const refs = [];
        const value = messages.map((message) => {
            const result = this.referenceOne(message, wanted);
            refs.push(...result.refs);
            return result.value;
        });
        return refs.length ? { value, refs } : { value: messages, refs };
    }
    referenceOne(message, wanted) {
        if (!Array.isArray(message?.content))
            return { value: message, refs: [] };
        const refs = [];
        const content = this.referenceBlocks(message.content, refs, wanted);
        return { value: content === message.content ? message : { ...message, content }, refs };
    }
    referenceBlocks(blocks, refs, wanted) {
        let changed = false;
        const out = blocks.map((block) => {
            const next = this.referenceBlock(block, refs, wanted);
            if (next !== block)
                changed = true;
            return next;
        });
        return changed ? out : blocks;
    }
    referenceBlock(block, refs, wanted) {
        if (block?.type === "tool_result" && Array.isArray(block.content)) {
            const content = this.referenceBlocks(block.content, refs, wanted);
            return content === block.content ? block : { ...block, content };
        }
        const source = block?.type === "image" ? block.source : undefined;
        if (source?.type !== "base64" || typeof source.data !== "string")
            return block;
        const sha = this.canonicalSha(source.data);
        if (sha === undefined || !wanted(sha))
            return block;
        refs.push(sha);
        return { ...block, source: { ...source, data: IMAGE_REF_PREFIX + sha } };
    }
    /** The image's sha when its base64 re-encodes identically (what the server stores). */
    canonicalSha(data) {
        let sha = this.shaOf.get(data);
        if (sha === undefined) {
            if (!isCanonicalBase64(data))
                return undefined;
            sha = createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
            this.rememberSha(data, sha);
        }
        return sha;
    }
    rememberSha(data, sha) {
        if (data.length > SHA_CACHE_MAX_CHARS)
            return;
        this.shaOf.set(data, sha);
        this.shaChars += data.length;
        while (this.shaChars > SHA_CACHE_MAX_CHARS) {
            const first = this.shaOf.keys().next().value;
            if (first === undefined)
                break;
            this.shaOf.delete(first);
            this.shaChars -= first.length;
        }
    }
}
/** Drops a map's oldest entries until it holds at most `max`. */
function dropOldest(map, max) {
    while (map.size > max) {
        const first = map.keys().next().value;
        if (first === undefined)
            break;
        map.delete(first);
    }
}
/** The shas a refusal names (409 detail), or undefined when it names none. */
export function missingImageShas(bodyText) {
    try {
        const listed = JSON.parse(bodyText)?.detail?.[MISSING_IMAGES_FIELD];
        if (!Array.isArray(listed))
            return undefined;
        return listed.filter((sha) => typeof sha === "string");
    }
    catch {
        return undefined;
    }
}
/**
 * A 400 about references: "never" when this key may not send any (stop for the
 * process), "this" when only this request's were refused (too many: send its bytes).
 */
export function refusesImageRefs(status, bodyText) {
    if (status !== 400 || !/image reference/i.test(bodyText))
        return false;
    return /own MemTree key/i.test(bodyText) ? "never" : "this";
}
/**
 * The server re-encodes the bytes it stores, so only base64 that decodes and re-encodes
 * to the same text may be referenced (padding included, no whitespace).
 */
export function isCanonicalBase64(data) {
    if (data.length === 0 || data.length % 4 !== 0 || !BASE64_RE.test(data))
        return false;
    // Only the last quantum can hide non-zero padding bits ("QR==" decodes like "QQ==").
    const tail = data.slice(-4);
    return Buffer.from(tail, "base64").toString("base64") === tail;
}
//# sourceMappingURL=image-refs.js.map