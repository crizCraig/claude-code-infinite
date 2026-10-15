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
 * Base64 image data is not text: Anthropic resizes every image to at most
 * MAX_IMAGE_TOKENS however many bytes it takes (and a tiny, very compressible
 * PNG can still cost the maximum), so each image payload counts as the maximum.
 */
/** Claude 4.7 and later (Opus 4.7+, Sonnet/Haiku 5+, Fable 5). */
export declare const CLAUDE_4_7_PLUS_BYTES_PER_TOKEN = 1.9;
/** Claude before 4.7 (4.5, 4.6 and older). */
export declare const CLAUDE_LEGACY_BYTES_PER_TOKEN = 2.4;
/** Models that are not Claude, or no model named. */
export declare const OTHER_BYTES_PER_TOKEN = 2.8;
/** Anthropic's largest per-image cost (Claude 4.7+: 2576 px, 4,784 tokens). */
export declare const MAX_IMAGE_TOKENS = 4784;
/** The conservative bytes per token of `model`'s tokenizer family. */
export declare function bytesPerTokenForModel(model: string | undefined): number;
/** Tokens `bytes` of text may cost on `model` (rounded up). */
export declare function conservativeTokensFromBytes(bytes: number, model: string | undefined): number;
/** Tokens a request body may cost on `model`: its text at the family ratio,
 * each image block (base64 or URL, at any depth) at one image's maximum.
 * A body that does not parse is all text, an over-estimate. */
export declare function conservativeBodyTokens(body: Buffer, model: string | undefined): number;
//# sourceMappingURL=token-estimate.d.ts.map