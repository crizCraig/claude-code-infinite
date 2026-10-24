/**
 * What an inline image costs, from its header alone (polychat
 * image_tokens.py mirrors the same rule): Anthropic counts
 * ceil(w / 28) * ceil(h / 28) visual tokens after scaling the image down,
 * aspect kept, to its model tier's limits (Claude 4.7+ and unknown models:
 * long edge 2576 px and 4,784 tokens; older Claude: 1568 px and 1,568).
 * A 574x551 screenshot is 420 tokens, not the ~74k its base64 would be as text.
 */

const PATCH_PX = 28;
const HIGH_RES = { maxEdge: 2576, maxTokens: 4_784 };
const STANDARD = { maxEdge: 1568, maxTokens: 1_568 };
/** Base64 characters decoded to find a header (48 KB of bytes). */
const HEADER_BASE64_CHARS = 65_536;
const CLAUDE_VERSION_RE =
  /claude-(?:opus|sonnet|haiku|fable|mythos|instant)?-?(\d{1,2})(?:[-.](\d{1,2}))?(?![0-9])/i;

export interface ImageTotals {
  /** Base64 characters of the inline images (their JSON bytes). */
  imageBytes: number;
  /** Their visual tokens by the rule above (the tier cap when a header is unreadable). */
  imageTokens: number;
}

const NO_IMAGES: ImageTotals = Object.freeze({ imageBytes: 0, imageTokens: 0 });
/** Totals already worked out for a body and model: a body is parsed once,
 * however often it is sized (a weak key: dropped with the body). */
const totalsByBody = new WeakMap<Buffer, { model: string | undefined; totals: ImageTotals }>();

/**
 * Inline images among a request body's message (and tool result) content
 * blocks; `model` picks the tier. Image-shaped JSON anywhere else (tool
 * inputs, schemas, system) is ordinary text.
 */
export function bodyImages(body: Buffer, model: string | undefined): ImageTotals {
  const known = totalsByBody.get(body);
  if (known && known.model === model) return known.totals;
  const totals = parseImages(body, model);
  totalsByBody.set(body, { model, totals });
  return totals;
}

/** Remember `totals` for another copy of the same bytes. */
export function rememberImages(body: Buffer, model: string | undefined, totals: ImageTotals): void {
  totalsByBody.set(body, { model, totals });
}

function parseImages(body: Buffer, model: string | undefined): ImageTotals {
  // Most bodies carry no image: skip the parse.
  if (!body.includes('"image"')) return NO_IMAGES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf-8"));
  } catch {
    return NO_IMAGES;
  }
  const totals = { imageBytes: 0, imageTokens: 0 };
  const tier = imageTier(model);
  const messages = (parsed as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return totals;
  for (const message of messages) {
    const content = (message as { content?: unknown } | null)?.content;
    if (Array.isArray(content)) addImages(content, tier, totals);
  }
  return Object.freeze(totals);
}

/** Visual tokens of a w x h image in `tier` (polychat visual_tokens). */
export function visualTokens(width: number, height: number, tier = HIGH_RES): number {
  if (!(width > 0) || !(height > 0)) return tier.maxTokens;
  const longest = Math.max(width, height);
  let longEdge = Math.max(1, Math.floor(longest * Math.min(1, tier.maxEdge / longest)));
  while (longEdge > 1) {
    const scale = longEdge / longest;
    const tokens = Math.ceil(Math.max(1, Math.floor(width * scale)) / PATCH_PX) *
      Math.ceil(Math.max(1, Math.floor(height * scale)) / PATCH_PX);
    if (tokens <= tier.maxTokens) return tokens;
    longEdge -= Math.max(1, Math.floor(longEdge / 200));
  }
  return 1;
}

/** Claude before 4.7 is standard; 4.7+, other and unknown models are high-res. */
export function imageTier(model: string | undefined): typeof HIGH_RES {
  const match = model ? CLAUDE_VERSION_RE.exec(model) : null;
  if (!match) return HIGH_RES;
  const major = Number(match[1]);
  const minor = match[2] ? Number(match[2]) : 0;
  return major > 4 || (major === 4 && minor >= 7) ? HIGH_RES : STANDARD;
}

/** Width and height from a PNG, GIF, WebP or JPEG header; undefined when unreadable. */
export function imageDimensions(base64: string): [number, number] | undefined {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64.slice(0, HEADER_BASE64_CHARS), "base64");
  } catch {
    return undefined;
  }
  return pngSize(bytes) ?? gifSize(bytes) ?? webpSize(bytes) ?? jpegSize(bytes);
}

function addImages(blocks: unknown[], tier: typeof HIGH_RES, totals: ImageTotals): void {
  for (const item of blocks) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    const source = block.source as Record<string, unknown> | undefined;
    if (block.type === "image" && source && typeof source === "object") {
      const data = source.type === "base64" && typeof source.data === "string" ? source.data : "";
      totals.imageBytes += data.length;
      const size = data ? imageDimensions(data) : undefined;
      totals.imageTokens += size ? visualTokens(size[0], size[1], tier) : tier.maxTokens;
    } else if (block.type === "tool_result" && Array.isArray(block.content)) {
      addImages(block.content, tier, totals);
    }
  }
}

function pngSize(b: Buffer): [number, number] | undefined {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString("ascii", 12, 16) !== "IHDR") {
    return undefined;
  }
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function gifSize(b: Buffer): [number, number] | undefined {
  if (b.length < 10 || b.toString("ascii", 0, 3) !== "GIF") return undefined;
  return [b.readUInt16LE(6), b.readUInt16LE(8)];
}

function webpSize(b: Buffer): [number, number] | undefined {
  if (b.length < 30 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP") {
    return undefined;
  }
  const chunk = b.toString("ascii", 12, 16);
  if (chunk === "VP8X") return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  if (chunk === "VP8L") {
    const bits = b.readUInt32LE(21);
    return [1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)];
  }
  if (chunk === "VP8 ") return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  return undefined;
}

const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf]);

function jpegSize(b: Buffer): [number, number] | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let i = 2;
  for (let steps = 0; steps < 2_048 && i + 9 < b.length; steps++) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (JPEG_FRAME_MARKERS.has(marker)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + b.readUInt16BE(i + 2);
  }
  return undefined;
}
