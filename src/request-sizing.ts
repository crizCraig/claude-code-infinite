/** Request-local sizing and selection. Shared response samples are copied once,
 * exact counts remain attached to immutable body bytes, and every candidate
 * shares the request's Count Tokens deadline and account cooldown. */
import { createHash } from "node:crypto";
import { plausibleSample, shouldCountTokens,
  type CountTokensSession, type CountTokensResult, type SizeSample } from "./count-tokens.js";
import { approxTokensFromBytes } from "./reqlog.js";
import { conservativeBodyTokens } from "./token-estimate.js";
import { acceptsContextOverflow } from "./turns.js";

/** Output room kept free on models that accept input + max_tokens over the
 * window, so the model can still answer a request that barely fits. */
export const OUTPUT_FLOOR_TOKENS = 16_000;

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
  /** Per-model conservative bound (token-estimate.ts): what delivery may rely
   * on without an exact count. */
  readonly conservativeTokens: number;
}

export class RequestSizing {
  private readonly candidates = new Map<string, RequestCandidate>();
  private readonly excludedFallbacks = new Set<RequestCandidate>();

  /** `model` is the request's model: it picks the tokenizer family's ratio. */
  constructor(private readonly counts: CountTokensSession, private readonly enabled: boolean,
    private readonly model?: string) {}

  /** The first registration fixes both bytes and learned sample for this request. */
  register(body: Buffer, kind: CandidateKind, sample?: SizeSample): RequestCandidate {
    const key = createHash("sha256").update(body).digest("hex");
    const existing = this.candidates.get(key);
    if (existing) return existing;
    const snapshot = plausibleSample(sample) ? Object.freeze({ ...sample }) : undefined;
    const candidate = Object.freeze({ key, body: Buffer.from(body), kind, sample: snapshot,
      estimate: Object.freeze(estimateRequestTokens(snapshot, body.length)),
      conservativeTokens: conservativeBodyTokens(body, this.model) });
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

  /** Whether this body's size is an exact Count Tokens result. */
  isExact(candidate: RequestCandidate): boolean {
    return this.counts.peek(candidate.body)?.tokens !== undefined;
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
    // Delivery counts whenever an estimate is all that says the body fits: the
    // learned estimate, or the conservative bound, does not fit on its own.
    const needed = shouldCountTokens(candidate.sample, candidate.body.length, estimate, limits.budget) ||
      (phase === "delivery" && !(fitsNative(estimate, estimateLimits(limits)) &&
        fitsNative(candidate.conservativeTokens, estimateLimits(limits))));
    if (!count && this.enabled && needed) count = await this.counts.count(candidate.body);
    if (count?.tokens !== undefined) return {
      tokens: count.tokens, source: "exact", estimatedTokens: estimate, count,
    };
    // A learned ratio can request compression, but cannot veto a body whose
    // conservative per-model bound fits when counting is unavailable or
    // disabled; nor can it admit one whose bound does not (2026-10-15: bytes/4
    // admitted a body Anthropic counted at 1.34M tokens on a 1M window).
    const bytes = phase === "delivery" &&
      (!this.enabled || count !== undefined || candidate.estimate.source === "bytes");
    return { tokens: bytes ? candidate.conservativeTokens : estimate,
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
      if (fitsMeasured(measurement, limits)) return { candidate, measurement };
    }
    return undefined;
  }
}

/** Tokens a fit check must leave free for output. Claude 4.5+ rejects a
 * request only when its input alone exceeds the window (platform.claude.com/
 * docs/en/build-with-claude/context-windows, "Context window overflow
 * behavior"), so those models reserve min(max_tokens, OUTPUT_FLOOR_TOKENS);
 * older and unknown models reserve the full max_tokens. */
export function outputReservation(model: string | undefined, maxTokens: unknown): number {
  if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens)) return 0;
  const output = Math.max(0, maxTokens);
  return acceptsContextOverflow(model) ? Math.min(output, OUTPUT_FLOOR_TOKENS) : output;
}

/** Admission: the relaxed output floor applies only to an exact count of this
 * body; estimates and fallbacks (failed or disabled counting) keep max_tokens. */
export function fitsMeasured(
  measurement: Pick<CandidateMeasurement, "tokens" | "source">, limits: SizingLimits,
): boolean {
  return fitsNative(measurement.tokens,
    measurement.source === "exact" ? limits : estimateLimits(limits));
}

/** The limits an estimate is judged by: the full max_tokens reservation. */
export function estimateLimits(limits: SizingLimits): SizingLimits {
  return { ...limits, output: Math.max(limits.output, limits.recountOutput ?? 0) };
}

/** `limits.output` is the reservation from outputReservation, not raw max_tokens. */
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
