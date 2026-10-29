import { type CountTokensSession, type CountTokensResult, type SizeSample } from "./count-tokens.js";
import { type ImageTotals } from "./image-tokens.js";
/** Output room kept free on models that accept input + max_tokens over the
 * window, so the model can still answer a request that barely fits. */
export declare const OUTPUT_FLOOR_TOKENS = 16000;
export type CandidateKind = "original" | "ride" | "replacement";
export interface SizingLimits {
    budget: number;
    context: number;
    /** Output room an exact count must leave (see outputReservation). */
    output: number;
    /** Full max_tokens, reserved for every estimate: an estimate that would not
     * fit with it is counted before delivery, and only an exact count may use
     * the relaxed `output` floor. */
    recountOutput?: number;
}
export interface PlannedSize {
    tokens: number;
    source: "reported" | "bytes";
}
export interface CandidateMeasurement {
    tokens: number;
    source: "exact" | "reported" | "bytes";
    /** Advisory estimate retained for compression and stale-estimate diagnostics. */
    estimatedTokens: number;
    count?: CountTokensResult;
    /** Over Anthropic's request size limit: it cannot be sent natively at any size. */
    tooLarge?: true;
}
export interface RequestCandidate {
    readonly key: string;
    /** Owned copy: callers must not mutate these bytes. */
    readonly body: Buffer;
    readonly kind: CandidateKind;
    readonly sample?: Readonly<SizeSample>;
    readonly estimate: Readonly<PlannedSize>;
    /** Per-model conservative bound (token-estimate.ts): what delivery may rely
     * on without an exact count. */
    readonly conservativeTokens: number;
}
export declare class RequestSizing {
    private readonly counts;
    private readonly enabled;
    private readonly model?;
    private readonly candidates;
    private readonly excludedFallbacks;
    /** `model` is the request's model: it picks the tokenizer family's ratio. */
    constructor(counts: CountTokensSession, enabled: boolean, model?: string | undefined);
    /** The first registration fixes both bytes and learned sample for this request. */
    register(body: Buffer, kind: CandidateKind, sample?: SizeSample): RequestCandidate;
    /** Eligibility belongs to route planning, not to a later byte-size guess. */
    excludeFallback(candidate: RequestCandidate): void;
    /** Every registered candidate planning has not excluded, in registration order. */
    fallbacks(): RequestCandidate[];
    /** Planning and metadata consult the same exact count, else the snapshotted estimate. */
    plan(candidate: RequestCandidate): PlannedSize;
    /** Whether this body could still get an exact count: counting is on and
     * no attempt for these bytes has completed (a failed one is reused). */
    canCount(candidate: RequestCandidate): boolean;
    /** Whether delivery's one retry (retryTimedOutCount) could still count this body. */
    canRetryCount(candidate: RequestCandidate): boolean;
    /** Whether Anthropic would refuse this body's size (413) before reading it. */
    exceedsRequestLimit(candidate: RequestCandidate): boolean;
    /** Whether the conservative bound alone admits this body under `limits`. */
    boundFits(candidate: RequestCandidate, limits: SizingLimits): boolean;
    /** Count a body at planning when only a count could admit it: no exact
     * count and its conservative bound does not fit. Delivery reuses the result. */
    countIfOverBound(candidate: RequestCandidate, limits: SizingLimits): Promise<void>;
    /** Whether this body's size is an exact Count Tokens result. */
    /** An exact count already made for these bytes, if any; never counts. */
    exactTokensFor(body: Buffer): number | undefined;
    isExact(candidate: RequestCandidate): boolean;
    clientInputTokens(candidate: RequestCandidate): number | undefined;
    /** Count only when a size decision needs it; all views reuse the same result. */
    measure(candidate: RequestCandidate, limits: SizingLimits, phase?: "plan" | "delivery"): Promise<CandidateMeasurement>;
    /**
     * When counting ran out of time, count again (once per request, with a
     * fresh allowance) the smallest candidate whose count timed out, and select
     * it if it then fits: a slow count must not refuse a body that fits
     * (2026-10-23: an ~850k request was refused after its count timed out).
     */
    retryTimedOutCount(limits: SizingLimits): Promise<{
        candidate: RequestCandidate;
        measurement: CandidateMeasurement;
    } | undefined>;
    /** The preferred body gets first chance; only validated registered candidates
     * are considered afterward. Exact overflow never degrades to a byte guess. */
    select(preferred: RequestCandidate, limits: SizingLimits): Promise<{
        candidate: RequestCandidate;
        measurement: CandidateMeasurement;
    } | undefined>;
}
/** Tokens a fit check must leave free for output. Claude 4.5+ rejects a
 * request only when its input alone exceeds the window (platform.claude.com/
 * docs/en/build-with-claude/context-windows, "Context window overflow
 * behavior"), so those models reserve min(max_tokens, OUTPUT_FLOOR_TOKENS);
 * older and unknown models reserve the full max_tokens. */
export declare function outputReservation(model: string | undefined, maxTokens: unknown): number;
/** Admission: the relaxed output floor applies only to an exact count of this
 * body; estimates and fallbacks (failed or disabled counting) keep max_tokens. */
export declare function fitsMeasured(measurement: Pick<CandidateMeasurement, "tokens" | "source" | "tooLarge">, limits: SizingLimits): boolean;
/** The limits an estimate is judged by: the full max_tokens reservation. */
export declare function estimateLimits(limits: SizingLimits): SizingLimits;
/** `limits.output` is the reservation from outputReservation, not raw max_tokens. */
export declare function fitsNative(input: number, limits: SizingLimits): boolean;
/**
 * One shared estimator for planner telemetry and request-local snapshots.
 * Inline images (`images`, and the sample's own) are not text: their base64
 * bytes are left out of the scaling and their visual tokens added as they are.
 * 2026-10-23: a 295k-character PNG (420 tokens) read as ~74k tokens of text
 * put an ~850k request at 892k and it was refused.
 */
export declare function estimateRequestTokens(sample: SizeSample | undefined, bytes: number, images?: ImageTotals): PlannedSize;
//# sourceMappingURL=request-sizing.d.ts.map