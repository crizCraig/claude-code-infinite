/**
 * SSE event surgery for speculative A/B streaming
 * (plans/2026-07-17_PLAN_speculative_ab_streaming.md).
 *
 * In compare mode the memory leg (A) is committed to the client from its
 * first upstream byte through an event-aligned forwarder, so a later "full
 * history is materially better" verdict can interrupt at an exact event
 * boundary: close A's open block, emit a bridge text block, then replay the
 * full leg (B) into the same SSE message envelope. Everything here is pure
 * event/byte transformation so it stays unit-testable without HTTP.
 */

import { StringDecoder } from "node:string_decoder";

/**
 * Permanent, model-visible copy for the interruption bridge block. Honest,
 * short, neutral — NOT a notice, never scrubbed.
 */
export const CORRECTION_BRIDGE_TEXT =
  "\n\n—\nCorrecting course — the full conversation history changes this:\n\n";
export const RECOVERY_BRIDGE_TEXT =
  "\n\n—\nThe first attempt was cut off; continuing from the full conversation history:\n\n";

/** One complete SSE frame: its verbatim bytes plus parsed data (if any). */
export interface SseFrame {
  raw: string;
  /** Last event: field, when one was supplied. */
  event?: string;
  /** Parsed, joined data: fields; undefined for no data or invalid JSON. */
  data?: any;
}

/**
 * Incremental, multibyte-safe SSE frame splitter. Every CRLF, bare CR, or LF
 * is a line ending, and an empty line dispatches an event; mixed line endings
 * are therefore accepted as required by the event-stream grammar. Yields only
 * COMPLETE frames so callers always operate on exact event boundaries.
 */
export class SseFrameScanner {
  private decoder = new StringDecoder("utf8");
  private buf = "";

  push(chunk: Buffer): SseFrame[] {
    this.buf += this.decoder.write(chunk);
    const frames: SseFrame[] = [];
    while (true) {
      const frameEnd = findSseFrameEnd(this.buf);
      if (frameEnd === -1) break;
      const raw = this.buf.slice(0, frameEnd);
      this.buf = this.buf.slice(frameEnd);
      frames.push({ raw, ...parseFrameFields(raw) });
    }
    return frames;
  }

  /** Whatever partial frame remains (normally empty at clean stream end). */
  flush(): string {
    const rest = this.buf + this.decoder.end();
    this.buf = "";
    return rest;
  }
}

/** CRLF is atomic here: a single CRLF must not look like two blank lines. */
function findSseFrameEnd(input: string): number {
  const match = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/.exec(input);
  return match ? match.index + match[0].length : -1;
}

function parseFrameFields(rawEvent: string): Pick<SseFrame, "event" | "data"> {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of rawEvent.split(/\r\n|\r|\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return event === undefined ? {} : { event };
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return event === undefined ? {} : { event };
  }
}

export function sseEventBytes(type: string, data: Record<string, any>): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Close the client-visible content block left open at a splice point. */
export function contentBlockStopEvent(index: number): string {
  return sseEventBytes("content_block_stop", {
    type: "content_block_stop",
    index,
  });
}

/**
 * The fabricated bridge text block between A's truncated content and B's
 * replayed content. Plain text — deliberately part of the assistant message.
 */
export function bridgeBlockEvents(index: number, text: string): string {
  return (
    sseEventBytes("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    }) +
    sseEventBytes("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    }) +
    sseEventBytes("content_block_stop", { type: "content_block_stop", index })
  );
}

export interface OpenBlock {
  index: number;
  type: string;
}

/** Whether the client-visible A prefix can be interrupted without corruption. */
export type SseInterruptDisposition = "splice" | "defer" | "blocked";

export interface SseForwarderOptions {
  /** Write one complete frame's verbatim bytes; false signals backpressure. */
  write: (bytes: string) => boolean;
  /**
   * Called after each frame has been written and state updated — the seam the
   * interrupt state machine uses to re-check a deferred splice on the exact
   * event boundary (a stop() here discards the rest of the current chunk).
   */
  afterEvent?: (forwarder: SseEventForwarder, data: any) => void;
  /**
   * Called instead of writing an upstream terminal error frame. The forwarder
   * is stopped first, allowing the delivery controller to recover from B
   * without ever exposing an error followed by a second answer.
   */
  onTerminalError?: (forwarder: SseEventForwarder, data: any) => void;
}

/**
 * Event-aligned delivery for leg A. Forwards each upstream event's bytes
 * VERBATIM on event boundaries (per-event flushing adds no meaningful
 * latency) while tracking exactly what is on the wire, so a splice always
 * happens at a complete-frame boundary with known block state.
 */
export class SseEventForwarder {
  /** The content block currently open on the client stream, if any. */
  openBlock: OpenBlock | null = null;
  /** Kept as an exact diagnostic even though every structured block locks out. */
  sawToolUse = false;
  /** message_delta forwarded — the message is closing; treat window as shut. */
  sawMessageDelta = false;
  sawMessageStop = false;
  sawTerminalError = false;
  /** Highest content block index forwarded to the client. */
  maxIndex = -1;
  /** Client-visible answer-text characters delivered (for spliceAtChars). */
  textChars = 0;

  private scanner = new SseFrameScanner();
  /** Complete frames accepted from an upstream chunk but not submitted yet. */
  private pendingFrames: SseFrame[] = [];
  /** Defensive retention if a caller pushes again before honoring false. */
  private pendingChunks: Buffer[] = [];
  private waitingForDrain = false;
  private pumping = false;
  /** Once structured/non-text content reaches the client, never splice later. */
  private interruptLocked = false;
  private stopped = false;

  constructor(private readonly opts: SseForwarderOptions) {}

  /**
   * Accept a chunk and forward its complete frames until backpressure. A false
   * return means the current frame was accepted by write(), but every later
   * frame is retained here and MUST wait for resumeAfterDrain().
   */
  push(chunk: Buffer): boolean {
    if (this.stopped) return true;
    if (this.waitingForDrain || this.pumping) {
      this.pendingChunks.push(Buffer.from(chunk));
      return false;
    }
    this.pendingFrames.push(...this.scanner.push(chunk));
    return this.pump();
  }

  /** Resume retained frames after the downstream emitted one drain event. */
  resumeAfterDrain(): boolean {
    if (this.stopped) {
      this.waitingForDrain = false;
      this.discardPending();
      return true;
    }
    if (!this.waitingForDrain) return this.pump();
    this.waitingForDrain = false;
    return this.pump();
  }

  /**
   * Interrupt policy for the exact prefix already submitted to the client.
   * Text can be closed synthetically, signed thinking must finish naturally,
   * and every other content block permanently shuts the splice window.
   */
  interruptDisposition(): SseInterruptDisposition {
    if (this.interruptLocked) return "blocked";
    if (this.openBlock === null || this.openBlock.type === "text") {
      return "splice";
    }
    return isThinkingBlockType(this.openBlock.type) ? "defer" : "blocked";
  }

  private pump(): boolean {
    if (this.pumping) return false;
    this.pumping = true;
    try {
      while (!this.stopped) {
        if (this.pendingFrames.length === 0) {
          const nextChunk = this.pendingChunks.shift();
          if (!nextChunk) return true;
          this.pendingFrames.push(...this.scanner.push(nextChunk));
          continue;
        }
        const frame = this.pendingFrames.shift()!;
        if (frame.event === "error" || frame.data?.type === "error") {
          this.sawTerminalError = true;
          this.stopped = true;
          this.discardPending();
          this.opts.onTerminalError?.(this, frame.data);
          return true;
        }
        this.observe(frame.data);
        const writable = this.opts.write(frame.raw);
        if (this.opts.afterEvent) this.opts.afterEvent(this, frame.data);
        if (!writable) {
          this.waitingForDrain = true;
          return false;
        }
      }
      this.discardPending();
      return true;
    } finally {
      this.pumping = false;
    }
  }

  /** Stop forwarding permanently; later frames (and partials) are discarded. */
  stop(): void {
    this.stopped = true;
    this.discardPending();
  }

  isStopped(): boolean {
    return this.stopped;
  }

  private observe(data: any): void {
    const type = data?.type;
    if (type === "content_block_start") {
      const blockType =
        typeof data.content_block?.type === "string"
          ? data.content_block.type
          : "unknown";
      if (!Number.isSafeInteger(data.index) || data.index < 0) {
        // We cannot fabricate a valid stop index for a malformed open block.
        this.interruptLocked = true;
        return;
      }
      this.openBlock = { index: data.index, type: blockType };
      if (data.index > this.maxIndex) this.maxIndex = data.index;
      if (blockType === "tool_use") this.sawToolUse = true;
      if (blockType !== "text" && !isThinkingBlockType(blockType)) {
        this.interruptLocked = true;
      }
      if (
        blockType === "text" &&
        typeof data.content_block.text === "string"
      ) {
        this.textChars += data.content_block.text.length;
      }
    } else if (type === "content_block_delta") {
      if (
        data.delta?.type === "text_delta" &&
        typeof data.delta.text === "string"
      ) {
        this.textChars += data.delta.text.length;
      }
    } else if (type === "content_block_stop") {
      this.openBlock = null;
    } else if (type === "message_delta") {
      this.sawMessageDelta = true;
    } else if (type === "message_stop") {
      this.sawMessageDelta = true;
      this.sawMessageStop = true;
    }
  }

  private discardPending(): void {
    this.pendingFrames.length = 0;
    this.pendingChunks.length = 0;
    if (this.stopped) this.scanner.flush();
  }
}

/**
 * Rewrites leg B's SSE bytes for replay inside A's already-open message
 * envelope: B's message_start and pings are dropped (A's envelope is on the
 * wire), B's thinking blocks are dropped whole (signed thinking from another
 * message is the riskiest replay surface and has no client-facing value),
 * and every kept content block is renumbered sequentially from startIndex.
 * B's message_delta / message_stop close the client message verbatim.
 */
export class SseSpliceWriter {
  private scanner = new SseFrameScanner();
  private nextIndex: number;
  private readonly indexMap = new Map<number, number>();
  private readonly droppedIndices = new Set<number>();

  constructor(opts: { startIndex: number }) {
    this.nextIndex = opts.startIndex;
  }

  push(chunk: Buffer): string {
    let out = "";
    for (const frame of this.scanner.push(chunk)) {
      out += this.transform(frame);
    }
    return out;
  }

  /** A splice never emits partial frames; any buffered tail is discarded. */
  flush(): void {
    this.scanner.flush();
  }

  private transform(frame: SseFrame): string {
    const data = frame.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return "";
    const type = data.type;
    if (type === "message_start" || type === "ping") return "";

    const isContentEvent =
      type === "content_block_start" ||
      type === "content_block_delta" ||
      type === "content_block_stop";
    if (isContentEvent) {
      // Malformed content events must never escape with B's original index:
      // doing so could collide with A or the bridge block on the client wire.
      if (!Number.isSafeInteger(data.index) || data.index < 0) return "";
      if (type === "content_block_start") {
        if (isThinkingBlockType(data.content_block?.type)) {
          this.droppedIndices.add(data.index);
          return "";
        }
        this.indexMap.set(data.index, this.nextIndex++);
      }
      if (this.droppedIndices.has(data.index)) return "";
      const mapped = this.indexMap.get(data.index);
      // A delta/stop whose start was never seen cannot render; drop it rather
      // than invent an index that could collide with a real block.
      if (mapped === undefined) return "";
      return sseEventBytes(type, { ...data, index: mapped });
    }

    // message_delta (B's stop_reason/usage), message_stop, error — verbatim.
    return frame.raw;
  }
}

function isThinkingBlockType(type: unknown): boolean {
  return type === "thinking" || type === "redacted_thinking";
}
