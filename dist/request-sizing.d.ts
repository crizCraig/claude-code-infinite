import { type CountTokensSession, type CountTokensResult, type SizeSample } from "./count-tokens.js";
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
export declare function fitsNative(input: number, limits: SizingLimits): boolean;
/** One shared estimator for planner telemetry and request-local snapshots. */
export declare function estimateRequestTokens(sample: SizeSample | undefined, bytes: number): PlannedSize;
//# sourceMappingURL=request-sizing.d.ts.map