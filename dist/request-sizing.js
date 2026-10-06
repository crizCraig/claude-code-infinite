/** Request-local sizing and selection. Shared response samples are copied once,
 * exact counts remain attached to immutable body bytes, and every candidate
 * shares the request's Count Tokens deadline and account cooldown. */
import { createHash } from "node:crypto";
import { plausibleSample, shouldCountTokens } from "./count-tokens.js";
import { approxTokensFromBytes } from "./reqlog.js";
export class RequestSizing {
    counts;
    enabled;
    candidates = new Map();
    excludedFallbacks = new Set();
    constructor(counts, enabled) {
        this.counts = counts;
        this.enabled = enabled;
    }
    /** The first registration fixes both bytes and learned sample for this request. */
    register(body, kind, sample) {
        const key = createHash("sha256").update(body).digest("hex");
        const existing = this.candidates.get(key);
        if (existing)
            return existing;
        const snapshot = plausibleSample(sample) ? Object.freeze({ ...sample }) : undefined;
        const candidate = Object.freeze({ key, body: Buffer.from(body), kind, sample: snapshot,
            estimate: Object.freeze(estimateRequestTokens(snapshot, body.length)) });
        this.candidates.set(key, candidate);
        return candidate;
    }
    /** Eligibility belongs to route planning, not to a later byte-size guess. */
    excludeFallback(candidate) {
        this.excludedFallbacks.add(candidate);
    }
    /** Planning and metadata consult the same exact count, else the snapshotted estimate. */
    plan(candidate) {
        const exact = this.counts.peek(candidate.body)?.tokens;
        return exact !== undefined ? { tokens: exact, source: "reported" } : candidate.estimate;
    }
    clientInputTokens(candidate) {
        const size = this.plan(candidate);
        return size.source === "reported" ? size.tokens : undefined;
    }
    /** Count only when a size decision needs it; all views reuse the same result. */
    async measure(candidate, limits, phase = "delivery") {
        let count = this.counts.peek(candidate.body);
        const estimate = candidate.estimate.tokens;
        const needed = shouldCountTokens(candidate.sample, candidate.body.length, estimate, limits.budget) ||
            (phase === "delivery" && !fitsNative(estimate, limits));
        if (!count && this.enabled && needed)
            count = await this.counts.count(candidate.body);
        if (count?.tokens !== undefined)
            return {
                tokens: count.tokens, source: "exact", estimatedTokens: estimate, count,
            };
        // A learned ratio can request compression, but cannot veto a body whose
        // plain estimate fits when counting is unavailable or disabled.
        const bytes = phase === "delivery" &&
            (!this.enabled || count !== undefined || candidate.estimate.source === "bytes");
        return { tokens: bytes ? Math.ceil(candidate.body.length / 4) : estimate,
            source: bytes ? "bytes" : candidate.estimate.source,
            estimatedTokens: estimate, count };
    }
    /** The preferred body gets first chance; only validated registered candidates
     * are considered afterward. Exact overflow never degrades to a byte guess. */
    async select(preferred, limits) {
        const others = [...this.candidates.values()].filter(item => item !== preferred && !this.excludedFallbacks.has(item));
        const rank = { replacement: 0, ride: 1, original: 2 };
        others.sort((a, b) => rank[a.kind] - rank[b.kind]);
        const ordered = preferred.kind === "original"
            ? [...others.filter(item => item.kind !== "original"), preferred,
                ...others.filter(item => item.kind === "original")]
            : [preferred, ...others];
        for (const candidate of ordered) {
            const measurement = await this.measure(candidate, limits);
            if (fitsNative(measurement.tokens, limits))
                return { candidate, measurement };
        }
        return undefined;
    }
}
export function fitsNative(input, limits) {
    return [input, limits.output, limits.context].every(value => Number.isFinite(value) && value >= 0) &&
        input + limits.output <= limits.context;
}
/** One shared estimator for planner telemetry and request-local snapshots. */
export function estimateRequestTokens(sample, bytes) {
    if (!plausibleSample(sample))
        return { tokens: approxTokensFromBytes(bytes), source: "bytes" };
    const ratio = sample.tokens / sample.forwardedBytes;
    const tokens = bytes <= sample.forwardedBytes ? Math.round(bytes * ratio) : sample.tokens +
        Math.max(approxTokensFromBytes(bytes - sample.forwardedBytes), Math.round((bytes - sample.forwardedBytes) * ratio));
    return { tokens, source: "reported" };
}
//# sourceMappingURL=request-sizing.js.map