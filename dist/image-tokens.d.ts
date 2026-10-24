/**
 * What an inline image costs, from its header alone (polychat
 * image_tokens.py mirrors the same rule): Anthropic counts
 * ceil(w / 28) * ceil(h / 28) visual tokens after scaling the image down,
 * aspect kept, to its model tier's limits (Claude 4.7+ and unknown models:
 * long edge 2576 px and 4,784 tokens; older Claude: 1568 px and 1,568).
 * A 574x551 screenshot is 420 tokens, not the ~74k its base64 would be as text.
 */
declare const HIGH_RES: {
    maxEdge: number;
    maxTokens: number;
};
export interface ImageTotals {
    /** Base64 characters of the inline images (their JSON bytes). */
    imageBytes: number;
    /** Their visual tokens by the rule above (the tier cap when a header is unreadable). */
    imageTokens: number;
}
/**
 * Inline images among a request body's message (and tool result) content
 * blocks; `model` picks the tier. Image-shaped JSON anywhere else (tool
 * inputs, schemas, system) is ordinary text.
 */
export declare function bodyImages(body: Buffer, model: string | undefined): ImageTotals;
/** Remember `totals` for another copy of the same bytes. */
export declare function rememberImages(body: Buffer, model: string | undefined, totals: ImageTotals): void;
/** Visual tokens of a w x h image in `tier` (polychat visual_tokens). */
export declare function visualTokens(width: number, height: number, tier?: {
    maxEdge: number;
    maxTokens: number;
}): number;
/** Claude before 4.7 is standard; 4.7+, other and unknown models are high-res. */
export declare function imageTier(model: string | undefined): typeof HIGH_RES;
/** Width and height from a PNG, GIF, WebP or JPEG header; undefined when unreadable. */
export declare function imageDimensions(base64: string): [number, number] | undefined;
export {};
//# sourceMappingURL=image-tokens.d.ts.map