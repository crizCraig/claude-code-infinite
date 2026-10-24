/**
 * The body of a MemTree call: image references (image-refs.ts) and a hard size limit.
 *
 * MemTree is served over HTTP/1 by Cloud Run, which refuses request bodies over
 * 32 MiB (a 413 before the server sees anything), so a body over MAX_MEMTREE_BODY_BYTES
 * is never sent. An index call is sent with its oldest inline images replaced by a
 * text placeholder until it fits (indexing loses those images, the session goes on);
 * a compress call is not sent at all and the turn degrades as on any failed compress.
 */
import { IMAGE_REF_PREFIX } from "./image-refs.js";
/** Under Cloud Run's 32 MiB HTTP/1 limit, with room for headers and rounding. */
export const MAX_MEMTREE_BODY_BYTES = 30 * 1024 * 1024;
export const IMAGE_OMITTED_TEXT = "[image omitted by ccc: the MemTree upload was over its size limit]";
const PLACEHOLDER = { type: "text", text: IMAGE_OMITTED_TEXT };
const PLACEHOLDER_BYTES = Buffer.byteLength(JSON.stringify(PLACEHOLDER), "utf-8");
/**
 * `body` with its messages as sent: stored images as references when `imageRefs` is
 * given, then, over `limitBytes`, an index call's oldest images dropped. `serialized`
 * is the messages' JSON already made (with references from the same `imageRefs`).
 */
export function planMemtreeBody(args) {
    const limit = args.limitBytes ?? MAX_MEMTREE_BODY_BYTES;
    const referenced = () => args.imageRefs?.referenceMessages(args.messages)
        ?? { value: args.messages, refs: [] };
    let sent = args.serialized;
    if (sent === undefined) {
        const { value, refs } = referenced();
        sent = { value: JSON.stringify(value), refs };
    }
    const payload = withMessagesJson(args.body, sent.value);
    const bytes = Buffer.byteLength(payload, "utf-8");
    if (bytes <= limit)
        return { payload, refs: sent.refs };
    const skipped = { refs: [], limit: { action: "skipped", requestBytes: bytes,
            imagesDropped: 0 } };
    if (!args.indexOnly)
        return skipped;
    const { value, refs } = referenced();
    // Each round drops what the last one left over; it stops when nothing is left to drop.
    let trimmed = { messages: value, dropped: 0 };
    let size = bytes;
    while (size > limit) {
        const next = dropOldestImages(trimmed.messages, size - limit);
        if (next.dropped === 0)
            return skipped;
        trimmed = { messages: next.messages, dropped: trimmed.dropped + next.dropped };
        const fitted = withMessagesJson(args.body, JSON.stringify(trimmed.messages));
        size = Buffer.byteLength(fitted, "utf-8");
        if (size <= limit) {
            return { payload: fitted, refs,
                limit: { action: "trimmed", requestBytes: bytes, imagesDropped: trimmed.dropped } };
        }
    }
    return skipped;
}
/** `body` (without messages) as JSON, with `messagesJson` as its `messages`. */
export function withMessagesJson(body, messagesJson) {
    const { messages: _ignored, ...rest } = body;
    const head = JSON.stringify(rest);
    return head === "{}" ? `{"messages":${messagesJson}}`
        : `${head.slice(0, -1)},"messages":${messagesJson}}`;
}
/**
 * `messages` with inline images, oldest first, replaced by IMAGE_OMITTED_TEXT until
 * at least `excessBytes` are saved; copy on write. References cost nothing and stay.
 */
export function dropOldestImages(messages, excessBytes) {
    const state = { saved: 0, dropped: 0, excess: excessBytes };
    const out = messages.map((message) => {
        if (state.saved >= state.excess || !Array.isArray(message?.content))
            return message;
        const content = dropInBlocks(message.content, state);
        return content === message.content ? message : { ...message, content };
    });
    return { messages: out, dropped: state.dropped };
}
function dropInBlocks(blocks, state) {
    let changed = false;
    const out = blocks.map((block) => {
        if (state.saved >= state.excess)
            return block;
        if (block?.type === "tool_result" && Array.isArray(block.content)) {
            const content = dropInBlocks(block.content, state);
            if (content === block.content)
                return block;
            changed = true;
            return { ...block, content };
        }
        const data = block?.type === "image" ? block.source?.data : undefined;
        if (typeof data !== "string" || data.startsWith(IMAGE_REF_PREFIX))
            return block;
        changed = true;
        state.saved += Buffer.byteLength(JSON.stringify(block), "utf-8") - PLACEHOLDER_BYTES;
        state.dropped += 1;
        return PLACEHOLDER;
    });
    return changed ? out : blocks;
}
//# sourceMappingURL=memtree-body.js.map