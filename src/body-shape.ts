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
   * The body holds something the anchor cannot bound: a message block outside
   * MESSAGE_BLOCKS (a document, a URL or file image, search results, server tool blocks, an
   * upload), a request field outside FRAME_FIELDS (mcp_servers) or a tool that is not a
   * custom one. Such a body never anchors a size (Codex r4-r7 P1s).
   */
  unanchorable: boolean;
  /**
   * Index of the last message holding a tool_reference (Anthropic expands it into the
   * tool's definition, past its bytes); -1 when none. Fine in the sampled part, which
   * Anthropic counted expanded; one appended disables the anchor.
   */
  lastExpanding: number;
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
    serverEdits: !noOpEdits(frame.context_management) || frame.compaction !== undefined,
    imageDims: [], unanchorable: !frameAnchorable(frame), lastExpanding: -1 };
  for (const message of messages) {
    const text = JSON.stringify(canonicalMessage(message)) ?? "";
    shape.messages.push(hash(text));
    shape.sizes.push(Buffer.byteLength(text, "utf-8"));
    shape.imageChars.push(imageCharsOf(message, shape));
    if (text.includes('"type":"tool_reference"')) shape.lastExpanding = shape.messages.length - 1;
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

function blockImageChars(blocks: unknown[], shape: BodyShape, nested = false): number {
  let total = 0;
  for (const item of blocks) {
    const block = item as Record<string, unknown> | null;
    if (!block || typeof block !== "object") continue;
    const source = block.source as Record<string, unknown> | undefined;
    if (block.type === "image" && source?.type === "base64" && typeof source.data === "string") {
      total += source.data.length;
      shape.imageDims.push(imageDimensions(source.data));
    } else if (block.type === "tool_result" && !nested) {
      if (Array.isArray(block.content)) total += blockImageChars(block.content, shape, true);
      else if (block.content !== undefined && typeof block.content !== "string") {
        shape.unanchorable = true;
      }
    } else if (!(nested ? NESTED_BLOCKS : MESSAGE_BLOCKS).has(String(block.type))) {
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
/**
 * Request fields whose cost is in the body (or none): anything else, such as mcp_servers
 * (tool definitions fetched remotely, Codex r7 P1), disables the anchor. compaction, and a
 * context_management that edits anything, are refused too (serverEdits, noOpEdits).
 */
const FRAME_FIELDS = new Set(["model", "max_tokens", "stream", "system", "tools", "tool_choice",
  "metadata", "thinking", "temperature", "top_p", "top_k", "stop_sequences", "output_config",
  "output_format", "speed", "service_tier", "cache_control", "context_management"]);

/**
 * Whether `context_management` edits nothing: absent, or only Claude Code's
 * `clear_thinking_20251015` with `keep: "all"`, which it sends whenever thinking is on.
 * Any other edit (clearing tool uses, or thinking past some turns) may make a count
 * describe edited input (review r2 P3).
 */
function noOpEdits(management: unknown): boolean {
  if (management === undefined) return true;
  const edits = (management as { edits?: unknown } | null)?.edits;
  return Array.isArray(edits) && Object.keys(management as object).every((k) => k === "edits") &&
    edits.every((edit) => {
      const e = edit as { type?: unknown; keep?: unknown } | null;
      return !!e && e.type === "clear_thinking_20251015" && e.keep === "all" &&
        Object.keys(e).every((k) => k === "type" || k === "keep");
    });
}

/** Whether the frame's cost is all in the body: known fields, custom tools only. */
function frameAnchorable(frame: Record<string, unknown>): boolean {
  if (!Object.keys(frame).every((key) => FRAME_FIELDS.has(key))) return false;
  const tools = frame.tools;
  if (tools === undefined) return true;
  return Array.isArray(tools) && tools.every((tool) => {
    const type = (tool as { type?: unknown } | null)?.type;
    return tool !== null && typeof tool === "object" && (type === undefined || type === "custom");
  });
}

const MESSAGE_BLOCKS = new Set(["text", "tool_use", "tool_result", "thinking",
  "redacted_thinking", "tool_addition", "tool_reference"]);
const NESTED_BLOCKS = new Set(["text", "tool_reference"]);
