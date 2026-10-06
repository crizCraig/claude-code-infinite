/** Request-local sizing and selection. Shared response samples are copied once,
 * exact counts remain attached to immutable body bytes, and every candidate
 * shares the request's Count Tokens deadline and account cooldown. */
import { createHash } from "node:crypto";
import { plausibleSample, shouldCountTokens,
  type CountTokensSession, type CountTokensResult, type SizeSample } from "./count-tokens.js";
import { approxTokensFromBytes } from "./reqlog.js";

export type CandidateKind = "original" | "ride" | "replacement";
export interface SizingLimits { budget: number; context: number; output: number }
export interface PlannedSize { tokens: number; source: "reported" | "bytes" }
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

export class RequestSizing {
  private readonly candidates = new Map<string, RequestCandidate>();
  private readonly excludedFallbacks = new Set<RequestCandidate>();

  constructor(private readonly counts: CountTokensSession, private readonly enabled: boolean) {}

  /** The first registration fixes both bytes and learned sample for this request. */
  register(body: Buffer, kind: CandidateKind, sample?: SizeSample): RequestCandidate {
    const key = createHash("sha256").update(body).digest("hex");
    const existing = this.candidates.get(key);
    if (existing) return existing;
    const snapshot = plausibleSample(sample) ? Object.freeze({ ...sample }) : undefined;
    const candidate = Object.freeze({ key, body: Buffer.from(body), kind, sample: snapshot,
      estimate: Object.freeze(estimateRequestTokens(snapshot, body.length)) });
    this.candidates.set(key, candidate);
    return candidate;
  }

  /** Eligibility belongs to route planning, not to a later byte-size guess. */
  excludeFallback(candidate: RequestCandidate): void {
    this.excludedFallbacks.add(candidate);
  }

  /** Planning and metadata consult the same exact count, else the snapshotted estimate. */
  plan(candidate: RequestCandidate): PlannedSize {
    const exact = this.counts.peek(candidate.body)?.tokens;
    return exact !== undefined ? { tokens: exact, source: "reported" } : candidate.estimate;
  }

  clientInputTokens(candidate: RequestCandidate): number | undefined {
    const size = this.plan(candidate);
    return size.source === "reported" ? size.tokens : undefined;
  }

  /** Count only when a size decision needs it; all views reuse the same result. */
  async measure(candidate: RequestCandidate, limits: SizingLimits,
    phase: "plan" | "delivery" = "delivery"): Promise<CandidateMeasurement> {
    let count = this.counts.peek(candidate.body);
    const estimate = candidate.estimate.tokens;
    const needed = shouldCountTokens(candidate.sample, candidate.body.length, estimate, limits.budget) ||
      (phase === "delivery" && !fitsNative(estimate, limits));
    if (!count && this.enabled && needed) count = await this.counts.count(candidate.body);
    if (count?.tokens !== undefined) return {
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
  async select(preferred: RequestCandidate, limits: SizingLimits): Promise<{
    candidate: RequestCandidate; measurement: CandidateMeasurement;
  } | undefined> {
    const others = [...this.candidates.values()].filter(item =>
      item !== preferred && !this.excludedFallbacks.has(item));
    const rank = { replacement: 0, ride: 1, original: 2 };
    others.sort((a, b) => rank[a.kind] - rank[b.kind]);
    const ordered = preferred.kind === "original"
      ? [...others.filter(item => item.kind !== "original"), preferred,
        ...others.filter(item => item.kind === "original")]
      : [preferred, ...others];
    for (const candidate of ordered) {
      const measurement = await this.measure(candidate, limits);
      if (fitsNative(measurement.tokens, limits)) return { candidate, measurement };
    }
    return undefined;
  }
}

export function fitsNative(input: number, limits: SizingLimits): boolean {
  return [input, limits.output, limits.context].every(value => Number.isFinite(value) && value >= 0) &&
    input + limits.output <= limits.context;
}

/** One shared estimator for planner telemetry and request-local snapshots. */
export function estimateRequestTokens(sample: SizeSample | undefined, bytes: number): PlannedSize {
  if (!plausibleSample(sample)) return { tokens: approxTokensFromBytes(bytes), source: "bytes" };
  const ratio = sample.tokens / sample.forwardedBytes;
  const tokens = bytes <= sample.forwardedBytes ? Math.round(bytes * ratio) : sample.tokens +
    Math.max(approxTokensFromBytes(bytes - sample.forwardedBytes),
      Math.round((bytes - sample.forwardedBytes) * ratio));
  return { tokens, source: "reported" };
}
