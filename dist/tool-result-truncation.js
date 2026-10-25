/**
 * Last-resort fit for a single tool result too large for the window even
 * after compression (polychat docs/context_memory_request_pipeline.md,
 * "Prepared compression"): keep its head and tail word for word and replace
 * the middle with a pointer to the full output, instead of refusing the
 * request. The full output is saved first (`saveFull`, tool-output-store.ts),
 * and the pointer names that file, which the model reads verbatim, page by
 * page, with Claude Code's own Read tool (MemTree indexes the conversation
 * too, but its tail read returns at most 40,000 characters of one message).
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
 * Shorten the tool result texts sent verbatim in the body (every user message's
 * tool_result blocks; a compressed prefix carries none), largest first, until
 * the body loses at least `cutChars` characters (or every text worth
 * shortening keeps only the minimum), or null when there is none or
 * `saveFull` could not save one. `saveFull` stores a whole text, returns where.
 * Every message, not only the newest: Claude Code resends an oversized result
 * on the turns after it, and each is shortened the same way again.
 */
export function truncateToolResults(body, cutChars, saveFull) {
    const messages = Array.isArray(body.messages) ? [...body.messages] : [];
    const plan = { originalChars: 0, omittedChars: 0, savedAt: [] };
    for (const site of toolTextSites(messages)) {
        if (plan.omittedChars >= cutChars)
            break;
        const cut = shortenSite(site, cutChars - plan.omittedChars, saveFull);
        if (cut === null)
            continue;
        if (cut === undefined)
            return null;
        const message = messages[site.messageIndex];
        messages[site.messageIndex] = { ...message, content: message.content.map((block, i) => i === site.blockIndex ? withToolText(block, site.partIndex, cut.text) : block) };
        plan.originalChars += site.text.length;
        plan.omittedChars += cut.omitted;
        plan.savedAt.push(cut.savedAt);
    }
    if (!plan.savedAt.length)
        return null;
    return { body: { ...body, messages }, ...plan };
}
/**
 * One text cut so it loses about `cutChars` (at most down to the minimum):
 * null when it is too short to shorten, undefined when it could not be saved.
 */
function shortenSite(site, cutChars, saveFull) {
    const longest = pointerText(site.text.length, site.text.length, "").length + PATH_ALLOWANCE;
    const keep = keptChars(site.text.length, cutChars + longest);
    if (keep === null)
        return null;
    const savedAt = saveFull(site.text);
    if (savedAt === undefined)
        return undefined;
    const pointer = (omitted) => pointerText(omitted, site.text.length, savedAt);
    return { ...cutMiddle(site.text, keep, pointer), savedAt };
}
/** The pointer that stands for the omitted middle. */
export function pointerText(omittedChars, totalChars, savedAt) {
    return `\n\n[… output truncated by MemTree to fit the context window: ` +
        `${omittedChars.toLocaleString("en-US")} of ${totalChars.toLocaleString("en-US")} ` +
        `characters omitted here. The full output is saved at ${savedAt}: read the omitted ` +
        `part with the Read tool (offset and limit) or search it with Grep …]\n\n`;
}
/** Room left in the pointer estimate for the saved file's path. */
const PATH_ALLOWANCE = 512;
/** Every tool result text of the user messages, largest first (newest first on a tie). */
function toolTextSites(messages) {
    const sites = [];
    messages.forEach((message, messageIndex) => {
        if (message?.role !== "user" || !Array.isArray(message.content))
            return;
        message.content.forEach((block, blockIndex) => {
            if (block?.type !== "tool_result")
                return;
            for (const [partIndex, text] of toolTexts(block.content)) {
                sites.push({ messageIndex, blockIndex, partIndex, text, toolUseId: block.tool_use_id });
            }
        });
    });
    return sites.sort((a, b) => b.text.length - a.text.length || b.messageIndex - a.messageIndex);
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
    return { text: text.slice(0, headEnd) + pointer(omitted) + text.slice(tailStart), omitted };
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