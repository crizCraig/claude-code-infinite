import type http from "node:http";
import https from "node:https";
/**
 * A request's counting allowance: past it the caller keeps its estimate.
 * Measured 2026-10-15 (reports/2026-10-15-count-tokens-latency.md): latency is
 * upload-bound, ~0.2 s plus body bytes at ~12 MB/s on a fast uplink (27 MB in
 * ~2.5 s, text or images alike), so a flat 3 s timed out on the 17-27 MB
 * image-heavy bodies that most needed a count. The allowance is 3 s plus 1 ms
 * per kB (a 1 MB/s, 8 Mbit/s uplink), capped at 30 s. It only binds when the
 * count is slow: a fast count returns as soon as it is done.
 */
export declare const COUNT_TOKENS_TIMEOUT_MS = 3000;
/** Upload rate the allowance still covers, in bytes per ms (1 MB/s). */
export declare const COUNT_UPLOAD_BYTES_PER_MS = 1000;
/** Most a request waits on counting, however large its bodies. */
export declare const COUNT_DEADLINE_MAX_MS = 30000;
/**
 * Anthropic's request size limit, the same on Messages and Count Tokens:
 * 67,108,864 bytes (64 MiB) is accepted, one byte more is answered 413
 * request_too_large from Content-Length alone (measured 2026-10-15). A body
 * over it cannot be sent natively at all, so it is never counted.
 */
export declare const ANTHROPIC_MAX_REQUEST_BYTES: number;
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
    /**
     * The body's inline images: their base64 bytes (within forwardedBytes) and
     * visual tokens (within tokens), so a later estimate scales only its text.
     * Absent on a sample recorded without them: its images count as text.
     */
    imageBytes?: number;
    imageTokens?: number;
}
/** Where a count call goes: the proxy's upstream. */
export interface CountTokensUpstream {
    module: typeof http | typeof https;
    host: string;
    port: number;
}
export type CountTokensOutcome = "success" | "timeout" | "network-error" | "invalid-response" | "http-error" | "server-error" | "auth" | "rate-limit" | "cooldown" | "aborted" | "deadline" | "invalid-request" | "too-large";
export interface CountTokensResult {
    outcome: CountTokensOutcome;
    /** Internal cooldown metadata; never log it. */
    retryAfter?: string;
    /** Exact input tokens; absent when the call failed or timed out. */
    tokens?: number;
    ms: number;
    status?: number;
    /** Body bytes the attempt was for (diagnostics). */
    bytes?: number;
    /** Allowance the attempt had (diagnostics). */
    timeoutMs?: number;
}
/** The counting allowance for a body of `bytes` (see COUNT_TOKENS_TIMEOUT_MS). */
export declare function countDeadlineMs(bytes: number): number;
/** Whether Anthropic rejects a body of `bytes` as too large (413), unseen. */
export declare function exceedsRequestLimit(bytes: number): boolean;
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
    /** A fixed allowance for the whole request instead of one scaled by size. */
    timeoutMs?: number;
    /** Allowance for a body of `bytes`; defaults to countDeadlineMs. */
    deadlineMs?: (bytes: number) => number;
    /** Called once per attempt; log only outcome and ms, never tokens or headers. */
    onAttempt?: (result: CountTokensResult) => void;
}
export interface CountTokensSession {
    count(body: Buffer): Promise<CountTokensResult>;
    peek(body: Buffer): CountTokensResult | undefined;
    /**
     * Count `body` again, once per request, after its count ran out of time or lost its
     * connection (RETRYABLE_COUNT_OUTCOMES), with a fresh allowance for its size;
     * undefined when it did not, or the retry was spent.
     */
    retry?(body: Buffer): Promise<CountTokensResult> | undefined;
}
/**
 * Outcomes a retry may follow: the count ran out of time or lost its connection, not
 * refused. A dropped connection says nothing about the body, like a timeout: a ride whose
 * count dropped stays the fallback a failed compress sends (2026-10-28, a Wi-Fi switch).
 */
export declare const RETRYABLE_COUNT_OUTCOMES: ReadonlySet<CountTokensOutcome>;
/**
 * Exact results belong to this request and body, never a shared sample slot.
 * All counts of one request share one allowance: the largest body's
 * (countDeadlineMs), spent only while a count is in flight, so time between
 * counts (a compression before the replacement is counted) is not charged.
 */
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