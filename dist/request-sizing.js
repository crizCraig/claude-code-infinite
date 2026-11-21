/** Request-local sizing and selection. Shared response samples are copied once,
 * exact counts remain attached to immutable body bytes, and every candidate
 * shares the request's Count Tokens deadline and account cooldown. */
import { createHash } from "node:crypto";
import { RETRYABLE_COUNT_OUTCOMES, exceedsRequestLimit, plausibleSample, shouldCountTokens } from "./count-tokens.js";
import { approxTokensFromBytes } from "./reqlog.js";
import { bodyImages, imageTier, rememberImages, visualTokens } from "./image-tokens.js";
import { bodyShape, knownShape, prefixDigest, rememberShape, textBytes } from "./body-shape.js";
import { conservativeBodyTokens, conservativeTokensFromBytes } from "./token-estimate.js";
import { acceptsContextOverflow } from "./turns.js";
/** Output room kept free on models that accept input + max_tokens over the
 * window, so the model can still answer a request that barely fits. */
export const OUTPUT_FLOOR_TOKENS = 16_000;
// The archived ~2 MB count typically returned in half a second. A retry
// after a fast disconnect can use at most one second of the original deadline.
const BRIEF_COUNT_RETRY_MS = 1_000;
const BRIEF_COUNT_RETRY_MAX_BYTES = 4 * 1024 * 1024;
export class RequestSizing {
    counts;
    enabled;
    model;
    lastExact;
    rememberExact;
    /** Input allowances derived from a verified prefix after a count actually failed. */
    failedCountSizes = new Map();
    candidates = new Map();
    excludedFallbacks = new Set();
    /** `model` is the request's model: it picks the tokenizer family's ratio. */
    constructor(counts, enabled, model, lastExact, rememberExact) {
        this.counts = counts;
        this.enabled = enabled;
        this.model = model;
        this.lastExact = lastExact;
        this.rememberExact = rememberExact;
    }
    /** The first registration fixes both bytes and learned sample for this request. */
    register(body, kind, sample) {
        const key = createHash("sha256").update(body).digest("hex");
        const existing = this.candidates.get(key);
        if (existing)
            return existing;
        const snapshot = plausibleSample(sample) ? Object.freeze({ ...sample }) : undefined;
        const images = bodyImages(body, this.model);
        const plain = conservativeBodyTokens(body, this.model);
        const conservativeTokens = Math.min(plain, (extendsSample(snapshot, body, this.model) &&
            anchoredBound(snapshot, bodyShape(body), this.model)) || Infinity);
        const owned = Buffer.from(body);
        // The same totals and shape answer for the owned copy (reportedSample of the sent bytes).
        rememberImages(owned, this.model, images);
        rememberShape(owned, knownShape(body));
        const candidate = Object.freeze({ key, body: owned, kind, sample: snapshot,
            estimate: Object.freeze(capByteEstimate(estimateRequestTokens(snapshot, body.length, images), conservativeTokens)),
            conservativeTokens, ...(conservativeTokens < plain ? { anchored: true } : {}) });
        this.candidates.set(key, candidate);
        return candidate;
    }
    /** Eligibility belongs to route planning, not to a later byte-size guess. */
    excludeFallback(candidate) {
        this.excludedFallbacks.add(candidate);
    }
    /** Every registered candidate planning has not excluded, in registration order. */
    fallbacks() {
        return [...this.candidates.values()].filter(item => !this.excludedFallbacks.has(item));
    }
    /** An exact count wins, then the guarded count-failure estimate, then the normal projection. */
    plan(candidate) {
        const exact = this.counts.peek(candidate.body)?.tokens;
        const tokens = exact ?? this.failedCountSizes.get(candidate);
        return tokens !== undefined ? { tokens, source: "reported" } : candidate.estimate;
    }
    /** Whether this body could still get an exact count: counting is on and
     * no attempt for these bytes has completed (a failed one is reused). */
    canCount(candidate) {
        return this.enabled && !exceedsRequestLimit(candidate.body.length) &&
            this.counts.peek(candidate.body) === undefined;
    }
    /** Whether delivery's one retry (retryTimedOutCount) could still count this body. */
    canRetryCount(candidate) {
        return this.enabled && this.counts.retry !== undefined && !this.exceedsRequestLimit(candidate) &&
            RETRYABLE_COUNT_OUTCOMES.has(this.counts.peek(candidate.body)?.outcome ?? "success");
    }
    /** Whether the transport byte limit rules out this body. */
    exceedsRequestLimit(candidate) {
        return exceedsRequestLimit(candidate.body.length);
    }
    /** Whether the conservative bound alone admits this body under `limits`. */
    boundFits(candidate, limits) {
        const tokens = this.failedCountSizes.get(candidate) ?? candidate.conservativeTokens;
        return !this.exceedsRequestLimit(candidate) && !this.failedOriginalNeedsCompression(candidate, limits) &&
            fitsNative(tokens, estimateLimits(limits));
    }
    /** Count a body at planning when only a count could admit it: no exact
     * count and its conservative bound does not fit. Delivery reuses the result. */
    async countIfOverBound(candidate, limits) {
        if (this.isExact(candidate) || !this.canCount(candidate) || this.boundFits(candidate, limits))
            return;
        await this.count(candidate);
    }
    failedCountTokens(candidate) {
        return this.failedCountSizes.get(candidate);
    }
    async count(candidate) {
        let count = await this.counts.count(candidate.body);
        const guarded = count.tokens === undefined && candidate.kind === "original"
            ? failedCountEstimate(this.lastExact, candidate.body, this.model) : undefined;
        if (guarded !== undefined && count.outcome === "network-error" && count.ms < BRIEF_COUNT_RETRY_MS &&
            candidate.body.length <= BRIEF_COUNT_RETRY_MAX_BYTES) {
            count = await this.counts.retry?.(candidate.body, BRIEF_COUNT_RETRY_MS) ?? count;
        }
        if (count.tokens !== undefined)
            this.recordExact(candidate, count.tokens);
        else if (candidate.kind === "original")
            this.failedCountSizes.set(candidate, guarded);
        return count;
    }
    recordExact(candidate, tokens) {
        this.failedCountSizes.delete(candidate);
        if (!this.rememberExact || !this.model)
            return;
        const shape = bodyShape(candidate.body, true);
        if (!shape || !shape.frameAnchorable || shape.serverEdits)
            return;
        const messageCount = shape.messages.length;
        this.rememberExact({ tokens, messageCount, model: this.model, at: Date.now(),
            prefixDigest: prefixDigest(shape, messageCount),
            billingDigest: shape.billingFrame && prefixDigest(shape, messageCount, shape.billingFrame),
            images: shape.imageDims.length });
    }
    failedOriginalNeedsCompression(candidate, limits) {
        return this.failedCountSizes.has(candidate) &&
            (this.failedCountSizes.get(candidate) ?? Infinity) >= limits.budget;
    }
    /** An exact count already made for these bytes, if any; never counts. */
    exactTokensFor(body) {
        return this.counts.peek(body)?.tokens;
    }
    isExact(candidate) {
        return this.counts.peek(candidate.body)?.tokens !== undefined;
    }
    clientInputTokens(candidate) {
        const exact = this.exactTokensFor(candidate.body);
        if (exact !== undefined)
            return exact;
        const size = candidate.estimate;
        return size.source === "reported" ? size.tokens : undefined;
    }
    /** Count only when a size decision needs it; all views reuse the same result. */
    async measure(candidate, limits, phase = "delivery") {
        let count = this.counts.peek(candidate.body);
        const estimate = candidate.estimate.tokens;
        // Delivery counts whenever an estimate is all that says the body fits: the
        // learned estimate, or the conservative bound, does not fit on its own.
        const needed = shouldCountTokens(candidate.sample, candidate.body.length, estimate, limits.budget, bodyImages(candidate.body, this.model)) ||
            (phase === "delivery" && !(fitsNative(estimate, estimateLimits(limits)) &&
                fitsNative(candidate.conservativeTokens, estimateLimits(limits))));
        const overByteLimit = exceedsRequestLimit(candidate.body.length);
        if (!overByteLimit && !count && this.enabled && needed)
            count = await this.count(candidate);
        if (overByteLimit)
            return {
                tokens: Math.max(estimate, candidate.conservativeTokens), source: "bytes",
                estimatedTokens: estimate, ...(count ? { count } : {}), tooLarge: true,
            };
        if (count?.tokens !== undefined)
            return {
                tokens: count.tokens, source: "exact", estimatedTokens: estimate, count,
            };
        const guarded = this.failedCountSizes.get(candidate);
        if (this.failedCountSizes.has(candidate)) {
            return { tokens: guarded ?? candidate.conservativeTokens,
                source: guarded === undefined ? "bytes" : "reported", estimatedTokens: estimate, count,
                ...(this.failedOriginalNeedsCompression(candidate, limits) ? { tooLarge: true } : {}) };
        }
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
    async retryTimedOutCount(limits) {
        if (!this.enabled || !this.counts.retry)
            return undefined;
        const timedOut = this.fallbacks().filter((item) => !this.exceedsRequestLimit(item) &&
            RETRYABLE_COUNT_OUTCOMES.has(this.counts.peek(item.body)?.outcome ?? "success"))
            .sort((a, b) => a.body.length - b.body.length);
        const smallest = timedOut[0];
        if (!smallest)
            return undefined;
        const count = await this.counts.retry(smallest.body);
        if (count?.tokens === undefined)
            return undefined;
        this.recordExact(smallest, count.tokens);
        const measurement = await this.measure(smallest, limits);
        return fitsMeasured(measurement, limits) ? { candidate: smallest, measurement } : undefined;
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
            if (fitsMeasured(measurement, limits))
                return { candidate, measurement };
        }
        return undefined;
    }
}
/** Tokens a fit check must leave free for output. Claude 4.5+ rejects a
 * request only when its input alone exceeds the window (platform.claude.com/
 * docs/en/build-with-claude/context-windows, "Context window overflow
 * behavior"), so those models reserve min(max_tokens, OUTPUT_FLOOR_TOKENS);
 * older and unknown models reserve the full max_tokens. */
export function outputReservation(model, maxTokens) {
    if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens))
        return 0;
    const output = Math.max(0, maxTokens);
    return acceptsContextOverflow(model) ? Math.min(output, OUTPUT_FLOOR_TOKENS) : output;
}
/** Admission: the relaxed output floor applies only to an exact count of this
 * body; estimates and fallbacks (failed or disabled counting) keep max_tokens. */
export function fitsMeasured(measurement, limits) {
    return !measurement.tooLarge && fitsNative(measurement.tokens, measurement.source === "exact" ? limits : estimateLimits(limits));
}
/** The limits an estimate is judged by: the full max_tokens reservation. */
export function estimateLimits(limits) {
    return { ...limits, output: Math.max(limits.output, limits.recountOutput ?? 0) };
}
/** `limits.output` is the reservation from outputReservation, not raw max_tokens. */
export function fitsNative(input, limits) {
    return [input, limits.output, limits.context].every(value => Number.isFinite(value) && value >= 0) &&
        input + limits.output <= limits.context;
}
/**
 * An uncalibrated bytes/4 estimate reads base64 images as text (a 1 MB image
 * is ~250k "tokens" but costs at most MAX_IMAGE_TOKENS), so it is capped at
 * the conservative bound, which is an upper bound. Text-only bodies are
 * unchanged: their bytes/4 is below the bound. A calibrated estimate is kept.
 */
function capByteEstimate(estimate, conservativeTokens) {
    if (estimate.source !== "bytes" || estimate.tokens <= conservativeTokens)
        return estimate;
    return { tokens: conservativeTokens, source: "bytes" };
}
/**
 * One shared estimator for planner telemetry and request-local snapshots.
 * Inline images (`images`, and the sample's own) are not text: their base64
 * bytes are left out of the scaling and their visual tokens added as they are.
 * 2026-10-23: a 295k-character PNG (420 tokens) read as ~74k tokens of text
 * put an ~850k request at 892k and it was refused.
 */
export function estimateRequestTokens(sample, bytes, images = NO_IMAGE_TOTALS) {
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
        Math.max(approxTokensFromBytes(textBytes - sampleBytes), Math.round((textBytes - sampleBytes) * ratio));
    return { tokens: text + images.imageTokens, source: "reported" };
}
/**
 * Share of a body's text its sample must already have measured for anchoredBound,
 * and the margin added on the sample's own tokens. See anchoredBound.
 */
export const ANCHOR_MIN_COVERAGE = 0.75;
export const ANCHOR_MARGIN = 0.1;
/**
 * An upper bound anchored on Anthropic's own count of an earlier body (`sample`) that this
 * one extends (extendsSample, checked by the caller): the sample's text tokens plus
 * ANCHOR_MARGIN, the messages appended since sized from their own canonical text bytes
 * (body-shape.ts) at the conservative per-model ratio, and every image at its visual
 * tokens. Undefined without a sample that recorded its images and lineage, or when the
 * sample measured under ANCHOR_MIN_COVERAGE of the body's text.
 *
 * Why: the plain bound reads all non-image bytes at 1.9 bytes per token. Base64 that
 * is not an image (thinking signatures, JSON escapes) is far cheaper, so an
 * image-heavy agent lane Anthropic counted at 491k tokens had a plain bound over its
 * 1M window (2026-11-12, ai-safety-sim): every turn was counted (a 22 MB re-upload,
 * 2.0 GB on that lane) and a timed-out count compressed a half-full lane. The margin
 * covers tokenizer variance and fields the frame hash treats as equal; the appended part
 * is bounded at the conservative ratio like before. Appended bytes come from the
 * canonical messages, never a raw byte difference, which a re-encoded prefix (escapes
 * written literally) could shrink to hide new content (Codex r2 P1).
 */
export function anchoredBound(sample, shape, model, margin = ANCHOR_MARGIN) {
    const parts = anchoredParts(sample, shape, model);
    if (!parts)
        return undefined;
    return Math.ceil(parts.measuredText * (1 + margin)) +
        conservativeTokensFromBytes(parts.newBytes, model) + parts.imageTokens;
}
function anchoredParts(sample, shape, model) {
    if (!plausibleSample(sample) || sample.imageBytes === undefined ||
        sample.imageTokens === undefined || sample.messageCount === undefined)
        return undefined;
    // Documents, URL images and other blocks it cannot bound never anchor (Codex r4-r6 P1s);
    // every inline image is charged from the
    // same parse that left it out of the text, so none escapes both (Codex r3 P1).
    if (shape.unanchorable || shape.lastExpanding >= sample.messageCount)
        return undefined;
    const sampled = textBytes(shape, 0, sample.messageCount);
    const appended = textBytes(shape, sample.messageCount);
    if (sampled < ANCHOR_MIN_COVERAGE * (sampled + appended))
        return undefined;
    return { measuredText: Math.max(0, sample.tokens - sample.imageTokens),
        newBytes: appended + shape.unhashedBytes, imageTokens: shapeImageTokens(shape, model) };
}
/** The worst observed projection shortfall in the small-growth archive was 2.84%. */
const COUNT_FAILURE_MARGIN = 0.05;
const EXACT_PREFIX_TTL_MS = 5 * 60_000;
function failedCountEstimate(sample, body, model) {
    if (!sample || model !== sample.model || Date.now() - sample.at >= EXACT_PREFIX_TTL_MS)
        return undefined;
    const shape = bodyShape(body, true);
    if (!shape || shape.serverEdits || !shape.frameAnchorable || shape.messages.length <= sample.messageCount ||
        shape.lastUnsized >= sample.messageCount || shape.lastExpanding >= sample.messageCount)
        return undefined;
    let addedBytes = textBytes(shape, sample.messageCount) + shape.unhashedBytes;
    if (prefixDigest(shape, sample.messageCount) !== sample.prefixDigest) {
        if (!sample.billingDigest || !shape.billingFrame ||
            prefixDigest(shape, sample.messageCount, shape.billingFrame) !== sample.billingDigest)
            return undefined;
        addedBytes += shape.billingBytes ?? 0;
    }
    const tier = imageTier(model);
    let addedTokens = addedBytes; // A new text byte can cost a whole token.
    for (const size of shape.imageDims.slice(sample.images)) {
        if (!size)
            return undefined;
        addedTokens += visualTokens(size[0], size[1], tier);
    }
    return sample.tokens + Math.ceil(addedTokens * (1 + COUNT_FAILURE_MARGIN));
}
/** Visual tokens of the shape's inline images (the tier cap for an unreadable one). */
function shapeImageTokens(shape, model) {
    const tier = imageTier(model);
    return shape.imageDims.reduce((sum, size) => sum + (size ? visualTokens(size[0], size[1], tier) : tier.maxTokens), 0);
}
/**
 * Whether `body` extends the body `sample` measured, on the same model: the sample's
 * frame (system, tools, ...) and messages unchanged at its start (body-shape.ts). Only
 * then is the sample's count a count of part of this body (review r1, Codex r1 P1s:
 * net byte growth admitted swapped content; route and prefix samples survive a model
 * switch).
 */
export function extendsSample(sample, body, model) {
    if (!sample?.prefixDigest || sample.messageCount === undefined || !model ||
        sample.model !== model)
        return false;
    const shape = bodyShape(body);
    return shape !== undefined && !shape.serverEdits &&
        prefixDigest(shape, sample.messageCount) === sample.prefixDigest;
}
const NO_IMAGE_TOTALS = Object.freeze({ imageBytes: 0, imageTokens: 0 });
//# sourceMappingURL=request-sizing.js.map