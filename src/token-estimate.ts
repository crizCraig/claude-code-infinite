/**
 * Conservative token estimates from request bytes, per model tokenizer family,
 * for when no exact Count Tokens result is available.
 *
 * bytes/4 under-counted Claude 4.7+ by ~1.8x: on 2026-10-15 (request 3bc78182)
 * a 3,238,930-byte flattened body was sized at 809,733 tokens and forwarded to
 * a 1M window; Anthropic counted 1,342,572 and refused it. These ratios are the
 * MemTree server's (polychat/chars_per_token.py): low percentiles of real
 * Claude Code and NanoGPT requests counted with Count Tokens, so an estimate
 * rarely says a body fits when it does not. Bytes are at least the characters
 * the server measures (JSON escapes and UTF-8 only add bytes), so dividing
 * bytes by a chars-per-token ratio errs high, never low.
 *
 * Base64 image data is not text: Anthropic charges an image by its pixel
 * dimensions (ceil(w/28) * ceil(h/28) after its tier's downscale, at most
 * MAX_IMAGE_TOKENS) however many bytes it takes, so each image counts its
 * visual tokens read from its header (image-tokens.ts).
 */
import { bodyImages } from "./image-tokens.js";

/** Claude 4.7 and later (Opus 4.7+, Sonnet/Haiku 5+, Fable 5). */
export const CLAUDE_4_7_PLUS_BYTES_PER_TOKEN = 1.9;
/** Claude before 4.7 (4.5, 4.6 and older). */
export const CLAUDE_LEGACY_BYTES_PER_TOKEN = 2.4;
/** Models that are not Claude, or no model named. */
export const OTHER_BYTES_PER_TOKEN = 2.8;
/** Anthropic's largest per-image cost (Claude 4.7+: 2576 px, 4,784 tokens). */
export const MAX_IMAGE_TOKENS = 4_784;
const CLAUDE_VERSION_RE =
  /claude-(?:opus|sonnet|haiku|fable|instant)?-?(\d{1,2})(?:[-.](\d{1,2}))?(?![0-9])/;

/** The conservative bytes per token of `model`'s tokenizer family. */
export function bytesPerTokenForModel(model: string | undefined): number {
  const id = (model ?? "").toLowerCase();
  if (!id) return OTHER_BYTES_PER_TOKEN;
  const match = CLAUDE_VERSION_RE.exec(id);
  if (!match) return id.includes("claude") ? CLAUDE_4_7_PLUS_BYTES_PER_TOKEN : OTHER_BYTES_PER_TOKEN;
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  return major > 4 || (major === 4 && minor >= 7)
    ? CLAUDE_4_7_PLUS_BYTES_PER_TOKEN : CLAUDE_LEGACY_BYTES_PER_TOKEN;
}

/** Tokens `bytes` of text may cost on `model` (rounded up). */
export function conservativeTokensFromBytes(bytes: number, model: string | undefined): number {
  if (!(bytes > 0)) return 0;
  return Math.ceil(bytes / bytesPerTokenForModel(model));
}

/** Tokens a request body may cost on `model`: its text at the family ratio,
 * each inline image content block (in a message or a tool_result) at its
 * visual tokens from its header (image-tokens.ts), the tier's maximum when
 * unreadable or not inline. A body that does not parse is all text, an over-estimate. */
export function conservativeBodyTokens(body: Buffer, model: string | undefined): number {
  const { imageBytes, imageTokens } = bodyImages(body, model);
  return conservativeTokensFromBytes(body.length - imageBytes, model) + imageTokens;
}
