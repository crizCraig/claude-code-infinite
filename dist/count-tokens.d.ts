import type http from "node:http";
import https from "node:https";
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
export type CountTokensOutcome = "success" | "timeout" | "network-error" | "invalid-response" | "http-error" | "server-error" | "auth" | "rate-limit" | "cooldown" | "aborted" | "deadline" | "invalid-request";
export interface CountTokensResult {
    outcome: CountTokensOutcome;
    /** Internal cooldown metadata; never log it. */
    retryAfter?: string;
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
/** Shared per proxy; only hashes of account/upstream identity are stored. */
export declare class CountTokensCooldowns {
    private readonly capacity;
    private readonly now;
    private readonly entries;
    constructor(capacity?: number, now?: () => number);
    active(key: string): boolean;
    record(key: string, result: CountTokensResult): void;
}
export interface CountTokensSessionOptions {
    upstream: CountTokensUpstream;
    headers: Record<string, string>;
    requestUrl: string | undefined;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Called once per attempt; log only outcome and ms, never tokens or headers. */
    onAttempt?: (result: CountTokensResult) => void;
}
export interface CountTokensSession {
    count(body: Buffer): Promise<CountTokensResult>;
    peek(body: Buffer): CountTokensResult | undefined;
}
/** Exact results belong to this request and body, never a shared sample slot. */
export declare function createCountTokensSession(options: CountTokensSessionOptions, cooldowns?: CountTokensCooldowns): CountTokensSession;
/** All failures resolve without tokens, including synchronous request errors. */
export declare function countUpstreamTokens(args: CountTokensSessionOptions & {
    body: Buffer;
}): Promise<CountTokensResult>;
/** The countable subset of a Messages request body, or null if it is not one. */
export declare function countTokensBody(body: Buffer): Buffer | null;
/** The Messages request's path with `/count_tokens` appended, query kept. */
export declare function countTokensPath(requestUrl: string | undefined): string;
//# sourceMappingURL=count-tokens.d.ts.map