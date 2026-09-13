/**
 * MemTree notice copy plus compatibility cleanup for legacy injected markers.
 *
 * Live notices are now rendered through Claude Code's display-only hooks (see
 * hooks.ts), never as Anthropic assistant content. The marker helpers and old
 * SSE/JSON rewriters remain exported so existing contaminated transcripts and
 * integrations can be cleaned safely. The marker is therefore a stable legacy
 * contract and must not change.
 */
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { UPGRADE_COMMAND } from "./update-check.js";
export const NOTICE_OPEN = "<cc-infinite-notice>";
export const NOTICE_CLOSE = "</cc-infinite-notice>";
export const COMPRESSED_NOTICE = "✓ MemTree · conversation optimized";
/** @deprecated Present only to recognize old notice copy in callers/tests. */
export const MODEL_HIDDEN_NOTICE = "<model does not see this message>";
export const DEGRADED_NOTICE = "⚠ MemTree degraded — this turn ran uncompressed";
export const PAYMENT_REQUIRED_NOTICE = "⚠ MemTree is off — payment required (compression + indexing disabled). Visit polychat.co to enable.";
export const SLOW_FIRST_TOKEN_NOTICE = "✨ Something special is happening — please wait…";
export const STARTUP_NOTICE = "∞ MemTree · Infinite Context Enabled ∞";
/**
 * Session-start banner delivered inside Claude Code via the SessionStart
 * hook's systemMessage. Styling mirrors the notice queue's conventions:
 * named-color SGR only, resetting foreground/intensity rather than issuing a
 * full reset, so surrounding renderer styles are preserved.
 *
 * Leading newlines are load-bearing: Claude Code renders a hook systemMessage
 * as `<hookName> says: <content>` on one line, so the first breaks the banner
 * off the label and the second leaves a blank line between them.
 */
export function startupNoticeText(color, update = null) {
    const banner = color
        ? "\n\n\x1b[2m·─╼\x1b[22m \x1b[36m∞\x1b[39m \x1b[1mMemTree\x1b[22m · " +
            "\x1b[32mInfinite Context Enabled\x1b[39m \x1b[36m∞\x1b[39m \x1b[2m╾─·\x1b[22m"
        : `\n\n·─╼ ${STARTUP_NOTICE} ╾─·`;
    return update ? `${banner}\n${updateNoticeText(update, color)}` : banner;
}
/**
 * One line under the banner when npm has a newer release. Versions come from
 * the registry document and are re-validated here so a hostile or malformed
 * response can never inject terminal controls into the hook payload.
 */
export function updateNoticeText(update, color) {
    const latest = sanitizeNoticeDetail(update.latest, 40);
    const current = sanitizeNoticeDetail(update.current, 40);
    const plain = `↑ claude-code-infinite ${latest} available (you have ${current}) — ${UPGRADE_COMMAND}`;
    if (!color)
        return plain;
    return (`\x1b[33m↑ claude-code-infinite ${latest} available\x1b[39m ` +
        `\x1b[2m(you have ${current})\x1b[22m — \x1b[1m${UPGRADE_COMMAND}\x1b[22m`);
}
/** Make server-provided detail safe and compact before terminal rendering. */
export function sanitizeNoticeDetail(text, maxLength = 300) {
    return text
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);
}
export function wrapNotice(text) {
    return `${NOTICE_OPEN}${text}${NOTICE_CLOSE}`;
}
const NOTICE_SPAN_RE = new RegExp(`${escapeRegExp(NOTICE_OPEN)}[\\s\\S]*?${escapeRegExp(NOTICE_CLOSE)}`, "g");
const NOTICE_CAPTURE_RE = new RegExp(`${escapeRegExp(NOTICE_OPEN)}([\\s\\S]*?)${escapeRegExp(NOTICE_CLOSE)}`, "g");
const LEGACY_NOTICE_PREFIXES = [
    "MemTree working - conversation consolidated",
    "⚠ MemTree degraded",
    "⚠ MemTree is off",
    "✨ Something special is happening",
];
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** Remove every complete <cc-infinite-notice>…</cc-infinite-notice> span, keeping surrounding text. */
export function exciseNoticeSpans(text) {
    return text.replace(NOTICE_SPAN_RE, "");
}
/** Targeted cleanup for system text, where users may legitimately quote tags. */
export function exciseKnownLegacyNoticeSpans(text) {
    return text.replace(NOTICE_CAPTURE_RE, (whole, inner) => LEGACY_NOTICE_PREFIXES.some((prefix) => inner.startsWith(prefix)) ? "" : whole);
}
/**
 * At least one complete marker span — exact envelope, or a notice CC merged
 * into surrounding text. Works on any raw text (a block's text, a whole
 * transcript line or file); a bare open tag with no close never matches.
 */
export function containsNoticeSpan(text) {
    const open = text.indexOf(NOTICE_OPEN);
    return open !== -1 && text.indexOf(NOTICE_CLOSE, open) !== -1;
}
function sanitizeContent(content, knownLegacyOnly = false) {
    const excise = knownLegacyOnly
        ? exciseKnownLegacyNoticeSpans
        : exciseNoticeSpans;
    if (typeof content === "string") {
        const cleaned = excise(content);
        if (cleaned === content) {
            return { content, stripped: false, empty: false };
        }
        return { content: cleaned, stripped: true, empty: cleaned.trim() === "" };
    }
    if (!Array.isArray(content)) {
        return { content, stripped: false, empty: false };
    }
    let stripped = false;
    const kept = [];
    for (const part of content) {
        if (typeof part === "string" && excise(part) !== part) {
            stripped = true;
            const cleaned = excise(part);
            if (cleaned.trim() !== "")
                kept.push(cleaned);
            continue;
        }
        if (part &&
            typeof part === "object" &&
            part.type === "text" &&
            typeof part.text === "string" &&
            excise(part.text) !== part.text) {
            stripped = true;
            const cleaned = excise(part.text);
            if (cleaned.trim() !== "")
                kept.push({ ...part, text: cleaned });
            continue;
        }
        kept.push(part); // untouched blocks retain object identity/signatures
    }
    return stripped
        ? { content: kept, stripped: true, empty: kept.length === 0 }
        : { content, stripped: false, empty: false };
}
/**
 * Strip pass: remove legacy injected notice content from request history.
 * Runs on EVERY /v1/messages and count_tokens body, on all paths, before the
 * dedupe hash. Complete marker spans are removed from legacy assistant/system
 * content, while human user messages are left byte-verbatim even if they quote
 * the envelope. Bare/incomplete tags are left untouched. Untouched blocks survive byte-identical to what Anthropic
 * produced (important for replayed thinking-block signatures); a text block
 * that merely CONTAINS the marker span (e.g. CC merged adjacent text blocks)
 * has the span excised and the surrounding text kept — any block containing
 * the marker is proxy-contaminated by definition, so byte-identity doesn't
 * apply. Returns the original array untouched when nothing matches, so
 * unmodified bodies stay verbatim.
 */
export function stripNoticeBlocks(messages) {
    let stripped = false;
    const out = [];
    for (const msg of messages) {
        if (msg?.role !== "assistant" && msg?.role !== "system") {
            out.push(msg);
            continue;
        }
        const cleaned = sanitizeContent(msg?.content, msg?.role === "system");
        if (!cleaned.stripped) {
            out.push(msg);
            continue;
        }
        stripped = true;
        if (!cleaned.empty)
            out.push({ ...msg, content: cleaned.content });
    }
    return stripped ? { messages: out, stripped } : { messages, stripped };
}
/** Remove legacy complete marker spans from Anthropic's top-level system value. */
export function stripNoticeSystem(system) {
    const cleaned = sanitizeContent(system, true);
    if (!cleaned.stripped)
        return { system, stripped: false };
    return {
        system: cleaned.empty ? undefined : cleaned.content,
        stripped: true,
    };
}
// ---------------------------------------------------------------------------
// SSE machinery
// ---------------------------------------------------------------------------
function sseEvent(type, data) {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
/** content_block_start/delta/stop triple for a notice text block. */
export function noticeBlockEvents(index, noticeText) {
    return (sseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
    }) +
        sseEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: wrapNotice(noticeText) },
        }) +
        sseEvent("content_block_stop", { type: "content_block_stop", index }));
}
/**
 * Fabricated stream prelude for the mid-stall case: a synthetic message_start
 * plus the notice as content block 0. Upstream's real events follow with its
 * message_start dropped and indexes shifted +1 (SseNoticeRewriter). Cost we
 * accept: upstream message_start carried input-token usage, which is lost —
 * message_delta usage at end of turn still passes through.
 */
export function fabricatedPrelude(model, noticeText) {
    return (sseEvent("message_start", {
        type: "message_start",
        message: {
            id: `msg_ccinfinite_${randomUUID()}`,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
        },
    }) + noticeBlockEvents(0, noticeText));
}
/**
 * Incremental SSE event rewriter. Feed raw upstream bytes with push(); write
 * the returned string to the client. Events we don't modify pass through as
 * their original bytes.
 */
export class SseNoticeRewriter {
    opts;
    decoder = new StringDecoder("utf8");
    buf = "";
    maxIndexSeen = -1;
    injectedResponseNotice = false;
    injectedEndNotice = false;
    constructor(opts) {
        this.opts = opts;
    }
    push(chunk) {
        this.buf += this.decoder.write(chunk);
        let out = "";
        while (true) {
            const lfSep = this.buf.indexOf("\n\n");
            const crlfSep = this.buf.indexOf("\r\n\r\n");
            if (lfSep === -1 && crlfSep === -1)
                break;
            const useCrlf = crlfSep !== -1 && (lfSep === -1 || crlfSep < lfSep);
            const sep = useCrlf ? crlfSep : lfSep;
            const frameEnd = sep + (useCrlf ? 4 : 2);
            const rawEvent = this.buf.slice(0, frameEnd);
            this.buf = this.buf.slice(frameEnd);
            out += this.transformEvent(rawEvent);
        }
        return out;
    }
    /** Anything buffered after the stream ends (normally empty). */
    flush() {
        const rest = this.buf + this.decoder.end();
        this.buf = "";
        return rest;
    }
    transformEvent(rawEvent) {
        const dataLine = rawEvent
            .split("\n")
            .find((line) => line.startsWith("data:"));
        if (!dataLine)
            return rawEvent; // comment/ping-only frame
        let data;
        try {
            data = JSON.parse(dataLine.slice(5).trim());
        }
        catch {
            return rawEvent;
        }
        const type = data?.type;
        if (this.opts.onEvent) {
            try {
                this.opts.onEvent(data);
            }
            catch {
                // observer must never break the stream
            }
        }
        const baseShift = this.opts.renumberBy ?? 0;
        if (baseShift && type === "message_start")
            return ""; // fabricated prelude sent ours
        const isContentEvent = type === "content_block_start" ||
            type === "content_block_delta" ||
            type === "content_block_stop";
        if (isContentEvent && typeof data.index === "number") {
            const originalIndex = data.index;
            const insertResponseNotice = type === "content_block_start" &&
                this.opts.beforeResponseNotice !== undefined &&
                !this.injectedResponseNotice &&
                !isThinkingBlock(data.content_block);
            if (insertResponseNotice)
                this.injectedResponseNotice = true;
            const shift = baseShift + (this.injectedResponseNotice ? 1 : 0);
            if (shift)
                data.index = originalIndex + shift;
            if (data.index > this.maxIndexSeen)
                this.maxIndexSeen = data.index;
            const transformed = shift ? sseEvent(type, data) : rawEvent;
            if (insertResponseNotice) {
                const noticeIndex = originalIndex + baseShift;
                if (noticeIndex > this.maxIndexSeen)
                    this.maxIndexSeen = noticeIndex;
                return (noticeBlockEvents(noticeIndex, this.opts.beforeResponseNotice) +
                    transformed);
            }
            return transformed;
        }
        if (type === "message_delta" || type === "message_stop") {
            let notices = "";
            // A max-token response can end after thinking without ever starting an
            // answer/tool block. Still surface compression success, after thinking.
            if (this.opts.beforeResponseNotice !== undefined &&
                !this.injectedResponseNotice) {
                this.injectedResponseNotice = true;
                const noticeIndex = Math.max(this.maxIndexSeen + 1, baseShift);
                this.maxIndexSeen = noticeIndex;
                notices += noticeBlockEvents(noticeIndex, this.opts.beforeResponseNotice);
            }
            if (this.opts.endOfTurnNotice && !this.injectedEndNotice) {
                this.injectedEndNotice = true;
                const noticeIndex = this.maxIndexSeen + 1;
                this.maxIndexSeen = noticeIndex;
                notices += noticeBlockEvents(noticeIndex, this.opts.endOfTurnNotice);
            }
            if (notices)
                return notices + rawEvent;
        }
        return rawEvent;
    }
}
function isThinkingBlock(part) {
    return part?.type === "thinking" || part?.type === "redacted_thinking";
}
/**
 * Non-streaming success responses: insert a notice after any leading thinking
 * blocks and before the answer/tool content. Keeping the real answer last is
 * important for `claude -p --output-format json`, which reports the last text
 * block as `.result`.
 */
export function insertNoticeBeforeResponseContent(body, noticeText) {
    try {
        const json = JSON.parse(body.toString("utf-8"));
        if (json?.type !== "message" || !Array.isArray(json.content))
            return null;
        const firstResponsePart = json.content.findIndex((part) => !isThinkingBlock(part));
        const index = firstResponsePart === -1 ? json.content.length : firstResponsePart;
        json.content.splice(index, 0, { type: "text", text: wrapNotice(noticeText) });
        return Buffer.from(JSON.stringify(json), "utf-8");
    }
    catch {
        return null;
    }
}
/**
 * Non-streaming responses: append the notice text block to the JSON body's
 * `content`. Returns null if the body isn't the expected shape (caller sends
 * the original bytes unmodified).
 */
export function appendNoticeToJsonBody(body, noticeText) {
    try {
        const json = JSON.parse(body.toString("utf-8"));
        if (json?.type !== "message" || !Array.isArray(json.content))
            return null;
        json.content.push({ type: "text", text: wrapNotice(noticeText) });
        return Buffer.from(JSON.stringify(json), "utf-8");
    }
    catch {
        return null;
    }
}
/** In-stream error frame for failures after a fabricated prelude has been sent. */
export function sseErrorEvent(message) {
    return sseEvent("error", {
        type: "error",
        error: { type: "api_error", message },
    });
}
//# sourceMappingURL=notices.js.map