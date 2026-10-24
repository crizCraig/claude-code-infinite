/**
 * The body of a MemTree call: image references (image-refs.ts) and a hard size limit.
 *
 * MemTree is served over HTTP/1 by Cloud Run, which refuses request bodies over
 * 32 MiB (a 413 before the server sees anything), so a body over MAX_MEMTREE_BODY_BYTES
 * is never sent. An index call is sent with its oldest inline images replaced by a
 * text placeholder until it fits (indexing loses those images, the session goes on);
 * a compress call is not sent at all and the turn degrades as on any failed compress.
 */
import { IMAGE_REF_PREFIX, type ImageRefs, type Referenced } from "./image-refs.js";
import type { Message } from "./turns.js";

/** Under Cloud Run's 32 MiB HTTP/1 limit, with room for headers and rounding. */
export const MAX_MEMTREE_BODY_BYTES = 30 * 1024 * 1024;
export const IMAGE_OMITTED_TEXT =
  "[image omitted by ccc: the MemTree upload was over its size limit]";

/** What the limit did to a call: sent with images dropped, or not sent. */
export interface BodyLimitNote {
  action: "trimmed" | "skipped";
  /** The body's size before anything was dropped. */
  requestBytes: number;
  imagesDropped: number;
}

export interface PlannedBody {
  /** The JSON to send; undefined when nothing that fits could be built. */
  payload?: string;
  /** Shas sent as references (a 409 then asks for their bytes). */
  refs: string[];
  limit?: BodyLimitNote;
}

/**
 * `body` with its messages as sent: stored images as references when `imageRefs` is
 * given, then, over `limitBytes`, an index call's oldest images dropped. `serialized`
 * is the messages' JSON already made (with references from the same `imageRefs`).
 */
export function planMemtreeBody(args: {
  body: Record<string, unknown>;
  messages: Message[];
  serialized?: Referenced<string>;
  imageRefs?: ImageRefs;
  indexOnly: boolean;
  limitBytes?: number;
}): PlannedBody {
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
  if (bytes <= limit) return { payload, refs: sent.refs };
  const skipped: PlannedBody = { refs: [], limit: { action: "skipped", requestBytes: bytes,
    imagesDropped: 0 } };
  if (!args.indexOnly) return skipped;
  const { value, refs } = referenced();
  const trimmed = dropOldestImages(value, bytes - limit);
  const fitted = withMessagesJson(args.body, JSON.stringify(trimmed.messages));
  if (Buffer.byteLength(fitted, "utf-8") > limit) return skipped;
  return { payload: fitted, refs,
    limit: { action: "trimmed", requestBytes: bytes, imagesDropped: trimmed.dropped } };
}

/** `body` (without messages) as JSON, with `messagesJson` as its `messages`. */
export function withMessagesJson(body: Record<string, unknown>, messagesJson: string): string {
  const { messages: _ignored, ...rest } = body;
  const head = JSON.stringify(rest);
  return head === "{}" ? `{"messages":${messagesJson}}`
    : `${head.slice(0, -1)},"messages":${messagesJson}}`;
}

/**
 * `messages` with inline images, oldest first, replaced by IMAGE_OMITTED_TEXT until
 * at least `excessBytes` are saved; copy on write. References cost nothing and stay.
 */
export function dropOldestImages(messages: Message[], excessBytes: number): {
  messages: Message[]; dropped: number;
} {
  const state = { saved: 0, dropped: 0, excess: excessBytes };
  const out = messages.map((message) => {
    if (state.saved >= state.excess || !Array.isArray(message?.content)) return message;
    const content = dropInBlocks(message.content, state);
    return content === message.content ? message : { ...message, content };
  });
  return { messages: out, dropped: state.dropped };
}

type DropState = { saved: number; dropped: number; excess: number };

function dropInBlocks(blocks: unknown[], state: DropState): unknown[] {
  let changed = false;
  const out = blocks.map((block: any) => {
    if (state.saved >= state.excess) return block;
    if (block?.type === "tool_result" && Array.isArray(block.content)) {
      const content = dropInBlocks(block.content, state);
      if (content === block.content) return block;
      changed = true;
      return { ...block, content };
    }
    const data = block?.type === "image" ? block.source?.data : undefined;
    if (typeof data !== "string" || data.startsWith(IMAGE_REF_PREFIX)) return block;
    changed = true;
    state.saved += data.length;
    state.dropped += 1;
    return { type: "text", text: IMAGE_OMITTED_TEXT };
  });
  return changed ? out : blocks;
}
