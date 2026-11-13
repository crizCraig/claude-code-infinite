/**
 * A request body's lineage, so a size anchored on an earlier body (request-sizing.ts
 * anchoredBound) is used only for a body that extends it: the same system prompt, tools
 * and model fields, and the earlier body's messages unchanged at the start of this one's.
 * Byte totals alone cannot say that (review r1, Codex r1 P1): Claude Code dropping old
 * thinking signatures (base64, nearly free) while adding as many bytes of dense tool output
 * keeps the totals and changes the tokens.
 *
 * Each message is hashed on its own in a canonical form: JSON.stringify of the message with
 * the cache_control markers Claude Code moves every turn removed, only where the API puts
 * them (a content block, a tool_result's inner block; in the frame, a system block, a tool,
 * the top level), never inside tool inputs or schemas (Codex r2 P1). The canonical length
 * and image characters of each message are kept too, so what was appended is sized from its
 * own canonical bytes, not from a raw byte difference a re-encoded prefix could hide
 * (Codex r2 P1).
 */
import { createHash } from "node:crypto";
import { imageDimensions } from "./image-tokens.js";
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
/** Canonical text bytes (images left out) of messages [from, to). */
export function textBytes(shape, from, to = shape.messages.length) {
    let total = 0;
    for (let i = Math.max(0, from); i < Math.min(to, shape.sizes.length); i++) {
        total += Math.max(0, shape.sizes[i] - shape.imageChars[i]);
    }
    return total;
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
    const shape = { frame: hash(JSON.stringify(canonicalFrame(frame))),
        messages: [], sizes: [], imageChars: [],
        serverEdits: frame.context_management !== undefined || frame.compaction !== undefined,
        imageDims: [], unanchorable: false, lastExpanding: -1 };
    for (const message of messages) {
        const text = JSON.stringify(canonicalMessage(message)) ?? "";
        shape.messages.push(hash(text));
        shape.sizes.push(Buffer.byteLength(text, "utf-8"));
        shape.imageChars.push(imageCharsOf(message, shape));
        if (text.includes('"type":"tool_reference"'))
            shape.lastExpanding = shape.messages.length - 1;
    }
    return shape;
}
function hash(text) {
    return createHash("sha256").update(text).digest("hex");
}
/** The frame without cache_control at the top level, on system blocks and on tools. */
function canonicalFrame(frame) {
    const rest = { ...frame };
    delete rest.cache_control;
    if (Array.isArray(rest.system))
        rest.system = rest.system.map(withoutMarker);
    if (Array.isArray(rest.tools))
        rest.tools = rest.tools.map(withoutMarker);
    return rest;
}
/** A message without cache_control on its content blocks (and tool results' blocks). */
function canonicalMessage(message) {
    const content = message?.content;
    if (!Array.isArray(content))
        return message;
    return { ...message, content: content.map((block) => {
            const bare = withoutMarker(block);
            if (bare && bare.type === "tool_result" && Array.isArray(bare.content)) {
                return { ...bare, content: bare.content.map(withoutMarker) };
            }
            return bare;
        }) };
}
function withoutMarker(block) {
    if (!block || typeof block !== "object" || Array.isArray(block))
        return block;
    const rest = { ...block };
    delete rest.cache_control;
    return rest;
}
/** Base64 characters of the message's inline images (content and tool results); each
 * image's dimensions, and any image that is not inline, are noted on `shape`. */
function imageCharsOf(message, shape) {
    const content = message?.content;
    return Array.isArray(content) ? blockImageChars(content, shape) : 0;
}
function blockImageChars(blocks, shape, nested = false) {
    let total = 0;
    for (const item of blocks) {
        const block = item;
        if (!block || typeof block !== "object")
            continue;
        const source = block.source;
        if (block.type === "image" && source?.type === "base64" && typeof source.data === "string") {
            total += source.data.length;
            shape.imageDims.push(imageDimensions(source.data));
        }
        else if (block.type === "tool_result" && !nested) {
            if (Array.isArray(block.content))
                total += blockImageChars(block.content, shape, true);
            else if (block.content !== undefined && typeof block.content !== "string") {
                shape.unanchorable = true;
            }
        }
        else if (!(nested ? NESTED_BLOCKS : MESSAGE_BLOCKS).has(String(block.type))) {
            shape.unanchorable = true;
        }
    }
    return total;
}
/**
 * Blocks whose cost the anchor can bound: text (by its bytes), inline base64 images (by
 * their dimensions), tool calls and results, thinking, tool additions (their definition
 * is inline), tool references (only where already counted: BodyShape.lastExpanding). Anything else (a document, which
 * Anthropic expands into page images and text far past its bytes; a URL or file image;
 * search results; server tool blocks; uploads) disables the anchor, so its size is the
 * plain bound or a count as before (Codex r4-r6 P1s).
 */
const MESSAGE_BLOCKS = new Set(["text", "tool_use", "tool_result", "thinking",
    "redacted_thinking", "tool_addition", "tool_reference"]);
const NESTED_BLOCKS = new Set(["text", "tool_reference"]);
//# sourceMappingURL=body-shape.js.map