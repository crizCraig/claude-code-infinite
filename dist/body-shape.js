/**
 * A request body's lineage, so a size anchored on an earlier body (request-sizing.ts
 * anchoredBound) is used only for a body that extends it: the same system prompt, tools
 * and model fields, and the earlier body's messages unchanged at the start of this one's.
 * Byte totals alone cannot say that (review r1, Codex r1 P1): Claude Code dropping old
 * thinking signatures (base64, nearly free) while adding as many bytes of dense tool output
 * keeps the totals and changes the tokens.
 *
 * Each message is hashed on its own (cache_control markers left out: Claude Code moves them
 * to the newest messages every turn), and the prefix digest is the hash of the first
 * `count` message hashes plus the hash of everything outside `messages`.
 */
import { createHash } from "node:crypto";
/** Below this a body is never anchored (its plain bound is small): no parse, no hashing. */
export const SHAPE_MIN_BYTES = 256 * 1024;
const shapes = new WeakMap();
/** The body's shape; undefined when it is small or not a JSON request with messages. */
export function bodyShape(body) {
    if (body.length < SHAPE_MIN_BYTES)
        return undefined;
    if (!shapes.has(body))
        shapes.set(body, computeShape(body));
    return shapes.get(body) ?? undefined;
}
/** The shape already worked out for `body`, if any; never computes one. */
export function knownShape(body) {
    return shapes.get(body) ?? undefined;
}
/** Remember `shape` for another copy of the same bytes. */
export function rememberShape(body, shape) {
    if (shape)
        shapes.set(body, shape);
}
/** Digest of the frame and the first `count` messages; undefined past the end. */
export function prefixDigest(shape, count) {
    if (!Number.isInteger(count) || count < 0 || count > shape.messages.length)
        return undefined;
    const hash = createHash("sha256").update(shape.frame);
    for (let i = 0; i < count; i++)
        hash.update(shape.messages[i]);
    return hash.digest("hex");
}
function computeShape(body) {
    let parsed;
    try {
        parsed = JSON.parse(body.toString("utf-8"));
    }
    catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return null;
    const { messages, ...frame } = parsed;
    if (!Array.isArray(messages))
        return null;
    return { frame: hashOf(frame), messages: messages.map(hashOf) };
}
function hashOf(value) {
    return createHash("sha256").update(JSON.stringify(value, withoutCacheControl) ?? "").digest("hex");
}
function withoutCacheControl(key, value) {
    return key === "cache_control" ? undefined : value;
}
//# sourceMappingURL=body-shape.js.map