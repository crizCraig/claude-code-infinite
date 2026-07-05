/**
 * Inject-and-strip inline notices
 * (plans/2026-07-05_PLAN_first_user_turn_nonblocking.md, "Inline alert delivery").
 *
 * The proxy sits on both directions of the wire: it injects user-facing
 * notices into the response stream as a dedicated assistant text block wrapped
 * in <cc-infinite-notice>…</cc-infinite-notice>, and strips marker-matching
 * blocks out of every subsequent request body before forwarding — so notices
 * render inline in the Claude Code UI but never reach the model. The marker
 * string is a stable public contract: resumed sessions must strip correctly
 * across client versions. Never change it.
 *
 * Injection shapes:
 * - Fabricated SSE prelude (slow-first-token "✨"): we emit message_start plus
 *   the notice block at index 0 ourselves, then drop upstream's message_start
 *   and renumber its content block indexes by +1.
 * - End-of-turn SSE append (degraded alert): insert the notice block before
 *   the final message_delta/message_stop, index = max seen + 1.
 * - Non-streaming append: push the notice text block onto the JSON `content`.
 */

import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { Message } from "./turns.js";

export const NOTICE_OPEN = "<cc-infinite-notice>";
export const NOTICE_CLOSE = "</cc-infinite-notice>";

export const DEGRADED_NOTICE =
  "⚠ MemTree degraded — this turn ran uncompressed";
export const SLOW_FIRST_TOKEN_NOTICE =
  "✨ Something special is happening — please wait…";

export function wrapNotice(text: string): string {
  return `${NOTICE_OPEN}${text}${NOTICE_CLOSE}`;
}

/** Exact marker envelope — the only shape we ever inject as a request-history block. */
export function isNoticeText(text: string): boolean {
  return (
    text.startsWith(NOTICE_OPEN) &&
    text.endsWith(NOTICE_CLOSE) &&
    text.length >= NOTICE_OPEN.length + NOTICE_CLOSE.length
  );
}

function isNoticeBlock(part: any): boolean {
  return (
    part &&
    typeof part === "object" &&
    part.type === "text" &&
    typeof part.text === "string" &&
    isNoticeText(part.text)
  );
}

/**
 * Strip pass: remove injected notice blocks from a request's message history.
 * Runs on EVERY /v1/messages and count_tokens body, on all paths, before the
 * dedupe hash. Surviving content is byte-identical to what Anthropic produced
 * (important for replayed thinking-block signatures). Returns the original
 * array untouched when nothing matches, so unmodified bodies stay verbatim.
 */
export function stripNoticeBlocks(messages: Message[]): {
  messages: Message[];
  stripped: boolean;
} {
  let stripped = false;
  const out: Message[] = [];
  for (const msg of messages) {
    if (msg?.role !== "assistant") {
      out.push(msg);
      continue;
    }
    const content = msg.content;
    if (typeof content === "string" && isNoticeText(content)) {
      stripped = true; // notice-only message: drop it entirely
      continue;
    }
    if (Array.isArray(content) && content.some(isNoticeBlock)) {
      stripped = true;
      const kept = content.filter((p) => !isNoticeBlock(p));
      if (kept.length) out.push({ ...msg, content: kept });
      // else: message was nothing but notices — drop it
      continue;
    }
    out.push(msg);
  }
  return stripped ? { messages: out, stripped } : { messages, stripped };
}

// ---------------------------------------------------------------------------
// SSE machinery
// ---------------------------------------------------------------------------

function sseEvent(type: string, data: Record<string, any>): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** content_block_start/delta/stop triple for a notice text block. */
export function noticeBlockEvents(index: number, noticeText: string): string {
  return (
    sseEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    }) +
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: wrapNotice(noticeText) },
    }) +
    sseEvent("content_block_stop", { type: "content_block_stop", index })
  );
}

/**
 * Fabricated stream prelude for the mid-stall case: a synthetic message_start
 * plus the notice as content block 0. Upstream's real events follow with its
 * message_start dropped and indexes shifted +1 (SseNoticeRewriter). Cost we
 * accept: upstream message_start carried input-token usage, which is lost —
 * message_delta usage at end of turn still passes through.
 */
export function fabricatedPrelude(model: string, noticeText: string): string {
  return (
    sseEvent("message_start", {
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
    }) + noticeBlockEvents(0, noticeText)
  );
}

export interface SseRewriteOptions {
  /** Drop upstream message_start and shift content block indexes (prelude case). */
  renumberBy?: number;
  /** Inject this notice before the final message_delta/message_stop. */
  endOfTurnNotice?: string;
}

/**
 * Incremental SSE event rewriter. Feed raw upstream bytes with push(); write
 * the returned string to the client. Events we don't modify pass through as
 * their original bytes.
 */
export class SseNoticeRewriter {
  private decoder = new StringDecoder("utf8");
  private buf = "";
  private maxIndexSeen = -1;
  private injectedEndNotice = false;

  constructor(private opts: SseRewriteOptions) {}

  push(chunk: Buffer): string {
    this.buf += this.decoder.write(chunk);
    let out = "";
    let sep: number;
    while ((sep = this.buf.indexOf("\n\n")) !== -1) {
      const rawEvent = this.buf.slice(0, sep + 2);
      this.buf = this.buf.slice(sep + 2);
      out += this.transformEvent(rawEvent);
    }
    return out;
  }

  /** Anything buffered after the stream ends (normally empty). */
  flush(): string {
    const rest = this.buf + this.decoder.end();
    this.buf = "";
    return rest;
  }

  private transformEvent(rawEvent: string): string {
    const dataLine = rawEvent
      .split("\n")
      .find((line) => line.startsWith("data:"));
    if (!dataLine) return rawEvent; // comment/ping-only frame

    let data: any;
    try {
      data = JSON.parse(dataLine.slice(5).trim());
    } catch {
      return rawEvent;
    }
    const type = data?.type;

    if (this.opts.renumberBy) {
      if (type === "message_start") return ""; // we already sent ours
      if (
        (type === "content_block_start" ||
          type === "content_block_delta" ||
          type === "content_block_stop") &&
        typeof data.index === "number"
      ) {
        data.index += this.opts.renumberBy;
        if (data.index > this.maxIndexSeen) this.maxIndexSeen = data.index;
        return sseEvent(type, data);
      }
    }

    if (type === "content_block_start" && typeof data.index === "number") {
      if (data.index > this.maxIndexSeen) this.maxIndexSeen = data.index;
    }

    if (
      this.opts.endOfTurnNotice &&
      !this.injectedEndNotice &&
      (type === "message_delta" || type === "message_stop")
    ) {
      this.injectedEndNotice = true;
      return (
        noticeBlockEvents(this.maxIndexSeen + 1, this.opts.endOfTurnNotice) +
        rawEvent
      );
    }

    return rawEvent;
  }
}

/**
 * Non-streaming responses: append the notice text block to the JSON body's
 * `content`. Returns null if the body isn't the expected shape (caller sends
 * the original bytes unmodified).
 */
export function appendNoticeToJsonBody(
  body: Buffer,
  noticeText: string
): Buffer | null {
  try {
    const json = JSON.parse(body.toString("utf-8"));
    if (json?.type !== "message" || !Array.isArray(json.content)) return null;
    json.content.push({ type: "text", text: wrapNotice(noticeText) });
    return Buffer.from(JSON.stringify(json), "utf-8");
  } catch {
    return null;
  }
}

/** In-stream error frame for failures after a fabricated prelude has been sent. */
export function sseErrorEvent(message: string): string {
  return sseEvent("error", {
    type: "error",
    error: { type: "api_error", message },
  });
}
