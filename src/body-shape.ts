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

export interface BodyShape {
  /** Hash of the body without `messages` (system, tools, thinking, ...). */
  frame: string;
  /** One hash per message, in order. */
  messages: string[];
  /** Each message's canonical JSON length (UTF-8 bytes, as the per-model ratios assume). */
  sizes: number[];
  /** Each message's inline image base64 characters (within its size). */
  imageChars: number[];
  /**
   * The body asks Anthropic to edit its input (context_management, compaction): a count or
   * usage may describe the edited input, so it never anchors a size (review r2 P3).
   */
  serverEdits: boolean;
  /** Each inline base64 image's dimensions (undefined when unreadable), in order. */
  imageDims: Array<[number, number] | undefined>;
  /**
   * The messages hold an image, document or upload resolved from outside the body (a URL
   * or file id): its content can change under an unchanged digest, so the body never
   * anchors a size (Codex r4/r5 P1s).
   */
  otherImages: boolean;
}

const shapes = new WeakMap<Buffer, BodyShape | null>();

/** The body's shape; undefined when it is small or not a JSON request with messages. */
export function bodyShape(body: Buffer): BodyShape | undefined {
  if (body.length < SHAPE_MIN_BYTES) return undefined;
  if (!shapes.has(body)) shapes.set(body, computeShape(body));
  return shapes.get(body) ?? undefined;
}

/** The shape already worked out for `body`, if any; never computes one. */
export function knownShape(body: Buffer): BodyShape | undefined {
  return shapes.get(body) ?? undefined;
}

/** Remember `shape` for another copy of the same bytes. */
export function rememberShape(body: Buffer, shape: BodyShape | undefined): void {
  if (shape) shapes.set(body, shape);
}

/** Digest of the frame and the first `count` messages; undefined past the end. */
export function prefixDigest(shape: BodyShape, count: number): string | undefined {
  if (!Number.isInteger(count) || count < 0 || count > shape.messages.length) return undefined;
  const hash = createHash("sha256").update(shape.frame);
  for (let i = 0; i < count; i++) hash.update(shape.messages[i]);
  return hash.digest("hex");
}

/** Canonical text bytes (images left out) of messages [from, to). */
export function textBytes(shape: BodyShape, from: number, to = shape.messages.length): number {
  let total = 0;
  for (let i = Math.max(0, from); i < Math.min(to, shape.sizes.length); i++) {
    total += Math.max(0, shape.sizes[i] - shape.imageChars[i]);
  }
  return total;
}

function computeShape(body: Buffer): BodyShape | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf-8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { messages, ...frame } = parsed as Record<string, unknown>;
  if (!Array.isArray(messages)) return null;
  const shape: BodyShape = { frame: hash(JSON.stringify(canonicalFrame(frame))),
    messages: [], sizes: [], imageChars: [],
    serverEdits: frame.context_management !== undefined || frame.compaction !== undefined,
    imageDims: [], otherImages: false };
  for (const message of messages) {
    const text = JSON.stringify(canonicalMessage(message)) ?? "";
    shape.messages.push(hash(text));
    shape.sizes.push(Buffer.byteLength(text, "utf-8"));
    shape.imageChars.push(imageCharsOf(message, shape));
  }
  return shape;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The frame without cache_control at the top level, on system blocks and on tools. */
function canonicalFrame(frame: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...frame };
  delete rest.cache_control;
  if (Array.isArray(rest.system)) rest.system = rest.system.map(withoutMarker);
  if (Array.isArray(rest.tools)) rest.tools = rest.tools.map(withoutMarker);
  return rest;
}

/** A message without cache_control on its content blocks (and tool results' blocks). */
function canonicalMessage(message: unknown): unknown {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return message;
  return { ...(message as object), content: content.map((block) => {
    const bare = withoutMarker(block) as Record<string, unknown> | null;
    if (bare && bare.type === "tool_result" && Array.isArray(bare.content)) {
      return { ...bare, content: bare.content.map(withoutMarker) };
    }
    return bare;
  }) };
}

function withoutMarker(block: unknown): unknown {
  if (!block || typeof block !== "object" || Array.isArray(block)) return block;
  const rest: Record<string, unknown> = { ...(block as Record<string, unknown>) };
  delete rest.cache_control;
  return rest;
}

/** Base64 characters of the message's inline images (content and tool results); each
 * image's dimensions, and any image that is not inline, are noted on `shape`. */
function imageCharsOf(message: unknown, shape: BodyShape): number {
  const content = (message as { content?: unknown } | null)?.content;
  return Array.isArray(content) ? blockImageChars(content, shape) : 0;
}

function blockImageChars(blocks: unknown[], shape: BodyShape): number {
  let total = 0;
  for (const item of blocks) {
    const block = item as Record<string, unknown> | null;
    if (!block || typeof block !== "object") continue;
    const source = block.source as Record<string, unknown> | undefined;
    if (block.type === "image" && source?.type === "base64" && typeof source.data === "string") {
      total += source.data.length;
      shape.imageDims.push(imageDimensions(source.data));
    } else if (externallyResolved(block)) {
      shape.otherImages = true;
    } else if (block.type === "tool_result" && Array.isArray(block.content)) {
      total += blockImageChars(block.content, shape);
    }
  }
  return total;
}

/** Inline sources: their content is in the body, so the digest covers it. */
const INLINE_SOURCES = new Set(["base64", "text", "content"]);

/**
 * A block Anthropic resolves from outside the body (an image or document by URL or file
 * id, a container upload): it can change under the same digest (Codex r4 and r5 P1s).
 */
function externallyResolved(block: Record<string, unknown>): boolean {
  if (block.type === "container_upload") return true;
  const source = block.source as Record<string, unknown> | undefined;
  if (block.type === "image") return true;
  return !!source && typeof source === "object" && !INLINE_SOURCES.has(String(source.type));
}
