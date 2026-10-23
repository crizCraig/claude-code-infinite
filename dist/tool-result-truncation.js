/**
 * Last-resort fit for a single tool result too large for the window even
 * after compression (polychat docs/context_memory_request_pipeline.md,
 * "Prepared compression"): keep its head and tail word for word and replace
 * the middle with a pointer to the full output in MemTree, instead of
 * refusing the request.
 *
 * MemTree has the whole result: the proxy sends every main-thread request's
 * full conversation to it for indexing (the caller checks it got there). Its
 * read_lines tool reads a message no tree covers yet ("tail") by position, up
 * to 40,000 characters a call; once the message is indexed, a search for a
 * phrase from the omitted part finds its transcript lines, which read_lines
 * pages through.
 */
/** Kept text is a multiple of this, so a slightly different overflow on the
 * next request usually produces the same bytes (a prompt-cache hit). */
const KEEP_QUANTUM_CHARS = 8_000;
/** Snap a cut to a line break within this distance, when there is one. */
const LINE_SNAP_CHARS = 2_000;
/** Never keep less of the result than this; below it there is nothing to show. */
const MIN_KEEP_CHARS = 2_000;
/** The head's share of what is kept (errors and summaries often end a log). */
const HEAD_SHARE = 0.5;
/**
 * Truncate the largest text of a tool result in the body's last message so
 * the body loses at least `cutChars` characters, or null when it has no
 * tool result text that large. `memtreePosition` is that message's position
 * in the conversation MemTree receives (the system prompt is its message 0).
 */
export function truncateLargestToolResult(body, cutChars, memtreePosition) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const messageIndex = messages.length - 1;
    const last = messages[messageIndex];
    if (!last || last.role !== "user" || !Array.isArray(last.content))
        return null;
    const site = largestToolText(last.content);
    if (!site)
        return null;
    const pointer = (omitted, phrase) => pointerText(omitted, site.text.length, memtreePosition, phrase);
    const longest = pointer(site.text.length, "x".repeat(SEARCH_PHRASE_MAX_CHARS)).length;
    const keep = keptChars(site.text.length, cutChars + longest);
    if (keep === null)
        return null;
    const { text, omitted } = cutMiddle(site.text, keep, pointer);
    const content = last.content.map((block, i) => i === site.blockIndex ? withToolText(block, site.partIndex, text) : block);
    return {
        body: { ...body, messages: [...messages.slice(0, -1), { ...last, content }] },
        messageIndex,
        ...(typeof site.toolUseId === "string" ? { toolUseId: site.toolUseId } : {}),
        originalChars: site.text.length,
        omittedChars: omitted,
    };
}
/** The pointer that stands for the omitted middle. */
export function pointerText(omittedChars, totalChars, position, phrase) {
    const search = phrase
        ? `; once it is indexed, MemTree search {"tree": "current", "query": "${phrase}"} ` +
            `finds the omitted part and read_lines on that hit reads it page by page`
        : "";
    return `\n\n[… output truncated by MemTree to fit the context window: ` +
        `${omittedChars.toLocaleString("en-US")} of ${totalChars.toLocaleString("en-US")} ` +
        `characters omitted here. The full output is in MemTree: read_lines ` +
        `{"tail": true, "start": ${position}, "end": ${position}, "full": true} shows its ` +
        `first 40,000 characters while it is not yet indexed${search} ` +
        `(if MemTree does not have it yet, retry shortly) …]\n\n`;
}
/** Longest search phrase quoted in a pointer. */
const SEARCH_PHRASE_MAX_CHARS = 60;
/** A few plain words from the start of the omitted part, for MemTree search. */
function searchPhrase(omitted) {
    const words = omitted.slice(0, 400).replace(/[^A-Za-z0-9_.\-]+/g, " ").trim().split(" ")
        .filter((word) => word.length > 1 && word.length <= 30).slice(0, 6);
    let phrase = "";
    for (const word of words) {
        const next = phrase ? `${phrase} ${word}` : word;
        if (next.length > SEARCH_PHRASE_MAX_CHARS)
            break;
        phrase = next;
    }
    return phrase;
}
function largestToolText(content) {
    let best = null;
    content.forEach((block, blockIndex) => {
        if (block?.type !== "tool_result")
            return;
        for (const [partIndex, text] of toolTexts(block.content)) {
            if (!best || text.length > best.text.length) {
                best = { blockIndex, partIndex, text, toolUseId: block.tool_use_id };
            }
        }
    });
    return best;
}
function toolTexts(content) {
    if (typeof content === "string")
        return [[-1, content]];
    if (!Array.isArray(content))
        return [];
    return content.flatMap((part, i) => part?.type === "text" && typeof part.text === "string" ? [[i, part.text]] : []);
}
function withToolText(block, partIndex, text) {
    if (partIndex < 0)
        return { ...block, content: text };
    const parts = block.content.map((part, i) => i === partIndex ? { ...part, text } : part);
    return { ...block, content: parts };
}
/**
 * Characters of the original to keep, quantized down; at least MIN_KEEP_CHARS
 * (a cut past that keeps the minimum, and the caller measures whether it is
 * enough); null when the result is too short to shorten at all.
 */
function keptChars(length, cut) {
    if (length <= MIN_KEEP_CHARS * 2)
        return null;
    const keep = Math.floor((length - cut) / KEEP_QUANTUM_CHARS) * KEEP_QUANTUM_CHARS;
    return Math.max(MIN_KEEP_CHARS, keep);
}
function cutMiddle(text, keep, pointer) {
    const headEnd = safeBoundary(text, snapToLine(text, Math.floor(keep * HEAD_SHARE), -1));
    const tailStart = Math.max(headEnd, safeBoundary(text, snapToLine(text, text.length - (keep - headEnd), 1)));
    const omitted = tailStart - headEnd;
    const phrase = searchPhrase(text.slice(headEnd, tailStart));
    return { text: text.slice(0, headEnd) + pointer(omitted, phrase) + text.slice(tailStart),
        omitted };
}
/** Move `at` to just after a nearby line break, toward `direction` first. */
function snapToLine(text, at, direction) {
    const from = Math.max(0, Math.min(text.length, at));
    const found = direction < 0
        ? text.lastIndexOf("\n", from - 1)
        : text.indexOf("\n", from);
    if (found < 0 || Math.abs(found - from) > LINE_SNAP_CHARS)
        return from;
    return found + 1;
}
/** Never split a UTF-16 surrogate pair. */
function safeBoundary(text, at) {
    const code = text.charCodeAt(at);
    return code >= 0xdc00 && code <= 0xdfff ? at + 1 : at;
}
//# sourceMappingURL=tool-result-truncation.js.map