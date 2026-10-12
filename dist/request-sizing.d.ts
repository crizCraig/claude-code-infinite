import { type CountTokensSession, type CountTokensResult, type SizeSample } from "./count-tokens.js";
/** Output room kept free on models that accept input + max_tokens over the
 * window, so the model can still answer a request that barely fits. */
export declare const OUTPUT_FLOOR_TOKENS = 16000;
export type CandidateKind = "original" | "ride" | "replacement";
export interface SizingLimits {
    budget: number;
    context: number;
    output: number;
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
}
export interface RequestCandidate {
    readonly key: string;
    /** Owned copy: callers must not mutate these bytes. */
    readonly body: Buffer;
    readonly kind: CandidateKind;
    readonly sample?: Readonly<SizeSample>;
    readonly estimate: Readonly<PlannedSize>;
}
export declare class RequestSizing {
    private readonly counts;
    private readonly enabled;
    private readonly candidates;
    private readonly excludedFallbacks;
    constructor(counts: CountTokensSession, enabled: boolean);
    /** The first registration fixes both bytes and learned sample for this request. */
    register(body: Buffer, kind: CandidateKind, sample?: SizeSample): RequestCandidate;
    /** Eligibility belongs to route planning, not to a later byte-size guess. */
    excludeFallback(candidate: RequestCandidate): void;
    /** Planning and metadata consult the same exact count, else the snapshotted estimate. */
    plan(candidate: RequestCandidate): PlannedSize;
    clientInputTokens(candidate: RequestCandidate): number | undefined;
    /** Count only when a size decision needs it; all views reuse the same result. */
    measure(candidate: RequestCandidate, limits: SizingLimits, phase?: "plan" | "delivery"): Promise<CandidateMeasurement>;
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
/** `limits.output` is the reservation from outputReservation, not raw max_tokens. */
export declare function fitsNative(input: number, limits: SizingLimits): boolean;
/** One shared estimator for planner telemetry and request-local snapshots. */
export declare function estimateRequestTokens(sample: SizeSample | undefined, bytes: number): PlannedSize;
//# sourceMappingURL=request-sizing.d.ts.map