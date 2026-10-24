/** Request-local sizing and selection. Shared response samples are copied once,
 * exact counts remain attached to immutable body bytes, and every candidate
 * shares the request's Count Tokens deadline and account cooldown. */
import { createHash } from "node:crypto";
import { RETRYABLE_COUNT_OUTCOMES, exceedsRequestLimit, plausibleSample, shouldCountTokens,
  type CountTokensSession, type CountTokensResult, type SizeSample } from "./count-tokens.js";
import { approxTokensFromBytes } from "./reqlog.js";
import { bodyImages, rememberImages, type ImageTotals } from "./image-tokens.js";
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
    const conservativeTokens = conservativeBodyTokens(body, this.model);
    const images = bodyImages(body, this.model);
    const owned = Buffer.from(body);
    // The same totals answer for the owned copy (reportedSample of the sent bytes).
    rememberImages(owned, this.model, images);
    const candidate = Object.freeze({ key, body: owned, kind, sample: snapshot,
      estimate: Object.freeze(capByteEstimate(estimateRequestTokens(snapshot, body.length, images),
        conservativeTokens)),
      conservativeTokens });
    this.candidates.set(key, candidate);
    return candidate;
  }

  /** Eligibility belongs to route planning, not to a later byte-size guess. */
  excludeFallback(candidate: RequestCandidate): void {
    this.excludedFallbacks.add(candidate);
  }

  /** Every registered candidate planning has not excluded, in registration order. */
  fallbacks(): RequestCandidate[] {
    return [...this.candidates.values()].filter(item => !this.excludedFallbacks.has(item));
  }

  /** Planning and metadata consult the same exact count, else the snapshotted estimate. */
  plan(candidate: RequestCandidate): PlannedSize {
    const exact = this.counts.peek(candidate.body)?.tokens;
    return exact !== undefined ? { tokens: exact, source: "reported" } : candidate.estimate;
  }

  /** Whether this body could still get an exact count: counting is on and
   * no attempt for these bytes has completed (a failed one is reused). */
  canCount(candidate: RequestCandidate): boolean {
    return this.enabled && this.counts.peek(candidate.body) === undefined &&
      !this.exceedsRequestLimit(candidate);
  }

  /** Whether Anthropic would refuse this body's size (413) before reading it. */
  exceedsRequestLimit(candidate: RequestCandidate): boolean {
    return exceedsRequestLimit(candidate.body.length);
  }

  /** Whether the conservative bound alone admits this body under `limits`. */
  boundFits(candidate: RequestCandidate, limits: SizingLimits): boolean {
    return !this.exceedsRequestLimit(candidate) &&
      fitsNative(candidate.conservativeTokens, estimateLimits(limits));
  }

  /** Count a body at planning when only a count could admit it: no exact
   * count and its conservative bound does not fit. Delivery reuses the result. */
  async countIfOverBound(candidate: RequestCandidate, limits: SizingLimits): Promise<void> {
    if (this.isExact(candidate) || !this.canCount(candidate) || this.boundFits(candidate, limits)) return;
    await this.counts.count(candidate.body);
  }

  /** Whether this body's size is an exact Count Tokens result. */
  /** An exact count already made for these bytes, if any; never counts. */
  exactTokensFor(body: Buffer): number | undefined {
    return this.counts.peek(body)?.tokens;
  }

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
    if (this.exceedsRequestLimit(candidate)) return {
      tokens: Math.max(estimate, candidate.conservativeTokens), source: "bytes",
      estimatedTokens: estimate, ...(count ? { count } : {}), tooLarge: true,
    };
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

  /**
   * When counting ran out of time, count again (once per request, with a
   * fresh allowance) the smallest candidate whose count timed out, and select
   * it if it then fits: a slow count must not refuse a body that fits
   * (2026-10-23: an ~850k request was refused after its count timed out).
   */
  async retryTimedOutCount(limits: SizingLimits): Promise<{
    candidate: RequestCandidate; measurement: CandidateMeasurement;
  } | undefined> {
    if (!this.enabled || !this.counts.retry) return undefined;
    const timedOut = this.fallbacks().filter((item) => !this.exceedsRequestLimit(item) &&
      RETRYABLE_COUNT_OUTCOMES.has(this.counts.peek(item.body)?.outcome ?? "success"))
      .sort((a, b) => a.body.length - b.body.length);
    const smallest = timedOut[0];
    if (!smallest) return undefined;
    const count = await this.counts.retry(smallest.body);
    if (count?.tokens === undefined) return undefined;
    const measurement = await this.measure(smallest, limits);
    return fitsMeasured(measurement, limits) ? { candidate: smallest, measurement } : undefined;
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
  measurement: Pick<CandidateMeasurement, "tokens" | "source" | "tooLarge">, limits: SizingLimits,
): boolean {
  return !measurement.tooLarge && fitsNative(measurement.tokens,
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

/**
 * An uncalibrated bytes/4 estimate reads base64 images as text (a 1 MB image
 * is ~250k "tokens" but costs at most MAX_IMAGE_TOKENS), so it is capped at
 * the conservative bound, which is an upper bound. Text-only bodies are
 * unchanged: their bytes/4 is below the bound. A calibrated estimate is kept.
 */
function capByteEstimate(estimate: PlannedSize, conservativeTokens: number): PlannedSize {
  if (estimate.source !== "bytes" || estimate.tokens <= conservativeTokens) return estimate;
  return { tokens: conservativeTokens, source: "bytes" };
}

/**
 * One shared estimator for planner telemetry and request-local snapshots.
 * Inline images (`images`, and the sample's own) are not text: their base64
 * bytes are left out of the scaling and their visual tokens added as they are.
 * 2026-10-23: a 295k-character PNG (420 tokens) read as ~74k tokens of text
 * put an ~850k request at 892k and it was refused.
 */
export function estimateRequestTokens(
  sample: SizeSample | undefined, bytes: number, images: ImageTotals = NO_IMAGE_TOTALS,
): PlannedSize {
  const textBytes = Math.max(0, bytes - images.imageBytes);
  if (!plausibleSample(sample)) {
    return { tokens: approxTokensFromBytes(textBytes) + images.imageTokens, source: "bytes" };
  }
  // A sample recorded without its images may hold them as text: scale this
  // body's images as text too (an over-estimate) rather than against it.
  if (sample.imageBytes === undefined && images.imageBytes > 0) {
    return estimateRequestTokens(sample, bytes);
  }
  const sampleBytes = Math.max(1, sample.forwardedBytes - (sample.imageBytes ?? 0));
  const sampleTokens = Math.max(1, sample.tokens - (sample.imageTokens ?? 0));
  const ratio = sampleTokens / sampleBytes;
  const text = textBytes <= sampleBytes ? Math.round(textBytes * ratio) : sampleTokens +
    Math.max(approxTokensFromBytes(textBytes - sampleBytes),
      Math.round((textBytes - sampleBytes) * ratio));
  return { tokens: text + images.imageTokens, source: "reported" };
}

const NO_IMAGE_TOTALS: ImageTotals = Object.freeze({ imageBytes: 0, imageTokens: 0 });
