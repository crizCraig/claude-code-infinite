/**
 * Exact input-token counts from Anthropic's Count Tokens endpoint, made with
 * the user's own credentials, for the size estimates that decide compaction
 * and the fallback refusal (route-fallback.ts).
 *
 * The proxy normally sizes a request from an earlier response's reported
 * usage (a tokens-per-byte sample). That sample can be missing (a fresh proxy
 * after a resume), stale (a big jump of new content of unknown density), or
 * wrong for the request at hand: on 2026-10-05 a 979-byte web-search helper
 * reported 12,040 input tokens (server-side search results count as input),
 * and the 12 tokens/byte it taught its lane sized the next 169,507-byte
 * subagent request at 2.08M tokens and refused it. Counting is free but costs
 * a round trip that re-uploads the body, so it runs only where the estimate
 * is unknown or decides the outcome, never on every request.
 */
import type http from "node:http";
import type https from "node:https";
/** Bound on a count call: past it the caller keeps its estimate. */
export declare const COUNT_TOKENS_TIMEOUT_MS = 3000;
/**
 * Plausible tokens per byte for a sample. Text runs ~0.25-0.5. Above 1 the
 * sample measured something other than the body (server tool results), as on
 * 2026-10-05 (12 tokens/byte). The floor is loose on purpose: base64 images
 * are very cheap per byte (a ~1.5MB screenshot is ~1.6k tokens), so a
 * screenshot-heavy session can sit well under 0.1 and must stay calibrated
 * rather than be counted on every request.
 */
export declare const MIN_PLAUSIBLE_TOKENS_PER_BYTE = 0.02;
export declare const MAX_PLAUSIBLE_TOKENS_PER_BYTE = 1;
/** A request size Anthropic reported, and the bytes of the body it was for. */
export interface SizeSample {
    /** input_tokens + cache_read_input_tokens + cache_creation_input_tokens. */
    tokens: number;
    forwardedBytes: number;
}
/** Where a count call goes: the proxy's upstream. */
export interface CountTokensUpstream {
    module: typeof http | typeof https;
    host: string;
    port: number;
}
export interface CountTokensResult {
    /** Exact input tokens; absent when the call failed or timed out. */
    tokens?: number;
    ms: number;
    status?: number;
}
/** Whether a sample's tokens-per-byte ratio can describe a request body. */
export declare function plausibleSample(sample: SizeSample | undefined): sample is SizeSample;
/**
 * Whether to count a request of `bytes` before deciding on it: with no usable
 * sample once its estimate is a real share of the budget, and with one only
 * after a jump of new content brings it near the budget. Small growth on a
 * calibrated sample is estimated well and is not counted.
 */
export declare function shouldCountTokens(sample: SizeSample | undefined, bytes: number, estimateTokens: number, budgetTokens: number): boolean;
/**
 * Count `body`'s input tokens upstream with the caller's headers (credentials,
 * anthropic-version, betas). Never rejects: any failure or a timeout resolves
 * without `tokens`, and the caller keeps its estimate.
 */
export declare function countUpstreamTokens(args: {
    upstream: CountTokensUpstream;
    headers: Record<string, string>;
    requestUrl: string | undefined;
    body: Buffer;
    signal?: AbortSignal;
    timeoutMs?: number;
}): Promise<CountTokensResult>;
/** The countable subset of a Messages request body, or null if it is not one. */
export declare function countTokensBody(body: Buffer): Buffer | null;
/** The Messages request's path with `/count_tokens` appended, query kept. */
export declare function countTokensPath(requestUrl: string | undefined): string;
//# sourceMappingURL=count-tokens.d.ts.map