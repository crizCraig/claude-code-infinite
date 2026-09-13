/**
 * MemTree notice copy plus compatibility cleanup for legacy injected markers.
 *
 * Live notices are now rendered through Claude Code's display-only hooks (see
 * hooks.ts), never as Anthropic assistant content. The marker helpers and old
 * SSE/JSON rewriters remain exported so existing contaminated transcripts and
 * integrations can be cleaned safely. The marker is therefore a stable legacy
 * contract and must not change.
 */
import type { Message } from "./turns.js";
import { type UpdateAvailable } from "./update-check.js";
export declare const NOTICE_OPEN = "<cc-infinite-notice>";
export declare const NOTICE_CLOSE = "</cc-infinite-notice>";
export declare const COMPRESSED_NOTICE = "\u2713 MemTree \u00B7 conversation optimized";
/** @deprecated Present only to recognize old notice copy in callers/tests. */
export declare const MODEL_HIDDEN_NOTICE = "<model does not see this message>";
export declare const DEGRADED_NOTICE = "\u26A0 MemTree degraded \u2014 this turn ran uncompressed";
export declare const PAYMENT_REQUIRED_NOTICE = "\u26A0 MemTree is off \u2014 payment required (compression + indexing disabled). Visit polychat.co to enable.";
export declare const SLOW_FIRST_TOKEN_NOTICE = "\u2728 Something special is happening \u2014 please wait\u2026";
export declare const STARTUP_NOTICE = "\u221E MemTree \u00B7 Infinite Context Enabled \u221E";
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
export declare function startupNoticeText(color: boolean, update?: UpdateAvailable | null): string;
/**
 * One line under the banner when npm has a newer release. Versions come from
 * the registry document and are re-validated here so a hostile or malformed
 * response can never inject terminal controls into the hook payload.
 */
export declare function updateNoticeText(update: UpdateAvailable, color: boolean): string;
/** Make server-provided detail safe and compact before terminal rendering. */
export declare function sanitizeNoticeDetail(text: string, maxLength?: number): string;
export declare function wrapNotice(text: string): string;
/** Remove every complete <cc-infinite-notice>…</cc-infinite-notice> span, keeping surrounding text. */
export declare function exciseNoticeSpans(text: string): string;
/** Targeted cleanup for system text, where users may legitimately quote tags. */
export declare function exciseKnownLegacyNoticeSpans(text: string): string;
/**
 * At least one complete marker span — exact envelope, or a notice CC merged
 * into surrounding text. Works on any raw text (a block's text, a whole
 * transcript line or file); a bare open tag with no close never matches.
 */
export declare function containsNoticeSpan(text: string): boolean;
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
export declare function stripNoticeBlocks(messages: Message[]): {
    messages: Message[];
    stripped: boolean;
};
/** Remove legacy complete marker spans from Anthropic's top-level system value. */
export declare function stripNoticeSystem(system: any): {
    system: any;
    stripped: boolean;
};
/** content_block_start/delta/stop triple for a notice text block. */
export declare function noticeBlockEvents(index: number, noticeText: string): string;
/**
 * Fabricated stream prelude for the mid-stall case: a synthetic message_start
 * plus the notice as content block 0. Upstream's real events follow with its
 * message_start dropped and indexes shifted +1 (SseNoticeRewriter). Cost we
 * accept: upstream message_start carried input-token usage, which is lost —
 * message_delta usage at end of turn still passes through.
 */
export declare function fabricatedPrelude(model: string, noticeText: string): string;
export interface SseRewriteOptions {
    /** Drop upstream message_start and shift content block indexes (prelude case). */
    renumberBy?: number;
    /** Insert this notice after leading thinking, before the first response block. */
    beforeResponseNotice?: string;
    /** Inject this notice before the final message_delta/message_stop. */
    endOfTurnNotice?: string;
    /**
     * Diagnostics observer: called with every parsed upstream event's data
     * object BEFORE any rewriting (so it sees message_start even when the
     * prelude drops it, and original block indexes). Exceptions are swallowed —
     * observation must never affect the stream.
     */
    onEvent?: (data: any) => void;
}
/**
 * Incremental SSE event rewriter. Feed raw upstream bytes with push(); write
 * the returned string to the client. Events we don't modify pass through as
 * their original bytes.
 */
export declare class SseNoticeRewriter {
    private opts;
    private decoder;
    private buf;
    private maxIndexSeen;
    private injectedResponseNotice;
    private injectedEndNotice;
    constructor(opts: SseRewriteOptions);
    push(chunk: Buffer): string;
    /** Anything buffered after the stream ends (normally empty). */
    flush(): string;
    private transformEvent;
}
/**
 * Non-streaming success responses: insert a notice after any leading thinking
 * blocks and before the answer/tool content. Keeping the real answer last is
 * important for `claude -p --output-format json`, which reports the last text
 * block as `.result`.
 */
export declare function insertNoticeBeforeResponseContent(body: Buffer, noticeText: string): Buffer | null;
/**
 * Non-streaming responses: append the notice text block to the JSON body's
 * `content`. Returns null if the body isn't the expected shape (caller sends
 * the original bytes unmodified).
 */
export declare function appendNoticeToJsonBody(body: Buffer, noticeText: string): Buffer | null;
/** In-stream error frame for failures after a fabricated prelude has been sent. */
export declare function sseErrorEvent(message: string): string;
//# sourceMappingURL=notices.d.ts.map