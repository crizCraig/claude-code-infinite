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
 * each inline image content block (in a message or a tool_result) at its
 * visual tokens from its header (image-tokens.ts), the tier's maximum when
 * unreadable or not inline. A body that does not parse is all text, an over-estimate. */
export declare function conservativeBodyTokens(body: Buffer, model: string | undefined): number;
//# sourceMappingURL=token-estimate.d.ts.map