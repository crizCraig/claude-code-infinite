/**
 * Pure helpers and contracts for live with-memory (A) vs full-history (B)
 * routing. The proxy owns the HTTP streams; this module owns the gate, grader
 * prompt/schema, runtime validation, and memory extraction.
 */

import { CORRECTION_BRIDGE_TEXT } from "./splice.js";
import type { Message } from "./turns.js";

export const DEFAULT_GRADE_PREFIX_TOKENS = 1_000;
export const APPROX_CHARS_PER_TOKEN = 4;
export const DEFAULT_GRADE_PREFIX_CHARS =
  DEFAULT_GRADE_PREFIX_TOKENS * APPROX_CHARS_PER_TOKEN;
export const DEFAULT_PREFIX_TIMEOUT_MS = 30_000;
export const DEFAULT_GRADER_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
export const DEFAULT_GATE_FRACTION = 0.5;
export const DEFAULT_GRADER_MODEL = "claude-opus-4-8";
/** Shadow-grader retry backoff bounds (speculative mode; off the delivery path). */
export const DEFAULT_GRADER_RETRY_MIN_DELAY_MS = 2_000;
export const DEFAULT_GRADER_RETRY_MAX_DELAY_MS = 5_000;

const INPUT_EXCERPT_CHARS = 4_000;
export const GRADING_TRUNCATION_MARKER =
  "\n…[truncated at grading prefix]";

export type AbVerdict = "A" | "B" | "tie";
export type AbWinner = "memory" | "full";

export interface FusionMetrics {
  consensus_points: string[];
  contradictions: string[];
  partial_coverage: string[];
  unique_insights_a: string[];
  unique_insights_b: string[];
  blind_spots: string[];
}

export interface FusionVerdict {
  metrics: FusionMetrics;
  verdict: AbVerdict;
  materially_different: boolean;
  reasoning: string;
}

export interface AbGradeInput {
  question: string;
  unfoldedMemory: string;
  memoryResponse: string;
  fullResponse: string;
  model: string;
  signal: AbortSignal;
}

export type AbGrader = (input: AbGradeInput) => Promise<FusionVerdict>;

export interface AbRoutingOptions {
  /** Test seam. Production omits this and uses the incoming Anthropic OAuth. */
  grader?: AbGrader;
  graderModel?: string;
  prefixChars?: number;
  prefixTimeoutMs?: number;
  graderTimeoutMs?: number;
  maxBufferedBytesPerLeg?: number;
  gateFraction?: number;
  effectiveContextTokens?: (model: string) => number | undefined;
  /** The research plan samples models without a prior. Defaults to true. */
  sampleWhenNoPrior?: boolean;
  /** Debug/test escape hatch; bypasses the effective-context gate. */
  forceComparison?: boolean;
  /**
   * Unsafe research opt-in: commit the memory leg from its first byte and
   * permit in-stream interruption. Buffered delivery remains the default until
   * real-Claude transcript replay has been validated end to end.
   */
  speculative?: boolean;
  /** Model-visible bridge text emitted when a B verdict splices mid-message. */
  bridgeText?: string;
  graderRetryMinDelayMs?: number;
  graderRetryMaxDelayMs?: number;
}

export interface ResolvedAbRoutingOptions {
  grader?: AbGrader;
  graderModel: string;
  prefixChars: number;
  prefixTimeoutMs: number;
  graderTimeoutMs: number;
  maxBufferedBytesPerLeg: number;
  gateFraction: number;
  effectiveContextTokens: (model: string) => number | undefined;
  sampleWhenNoPrior: boolean;
  forceComparison: boolean;
  speculative: boolean;
  bridgeText: string;
  graderRetryMinDelayMs: number;
  graderRetryMaxDelayMs: number;
}

export type AbGateReason =
  | "forced"
  | "above-threshold"
  | "below-threshold"
  | "sample-no-prior"
  | "skip-no-prior";

export interface AbGateDecision {
  compare: boolean;
  reason: AbGateReason;
  contextTokens: number;
  effectiveContextTokens?: number;
  thresholdTokens?: number;
}

export function resolveAbRoutingOptions(
  opts: AbRoutingOptions
): ResolvedAbRoutingOptions {
  const retryMinDelay = positiveInt(
    opts.graderRetryMinDelayMs,
    DEFAULT_GRADER_RETRY_MIN_DELAY_MS
  );
  return {
    grader: opts.grader,
    graderModel: opts.graderModel ?? DEFAULT_GRADER_MODEL,
    prefixChars: positiveInt(opts.prefixChars, DEFAULT_GRADE_PREFIX_CHARS),
    prefixTimeoutMs: positiveInt(
      opts.prefixTimeoutMs,
      DEFAULT_PREFIX_TIMEOUT_MS
    ),
    graderTimeoutMs: positiveInt(
      opts.graderTimeoutMs,
      DEFAULT_GRADER_TIMEOUT_MS
    ),
    maxBufferedBytesPerLeg: positiveInt(
      opts.maxBufferedBytesPerLeg,
      DEFAULT_MAX_BUFFERED_BYTES
    ),
    gateFraction: positiveNumber(opts.gateFraction, DEFAULT_GATE_FRACTION),
    effectiveContextTokens:
      opts.effectiveContextTokens ?? effectiveContextForModel,
    sampleWhenNoPrior: opts.sampleWhenNoPrior ?? true,
    forceComparison: opts.forceComparison ?? false,
    speculative: opts.speculative ?? false,
    bridgeText:
      typeof opts.bridgeText === "string" && opts.bridgeText.length > 0
        ? opts.bridgeText
        : CORRECTION_BRIDGE_TEXT,
    graderRetryMinDelayMs: retryMinDelay,
    graderRetryMaxDelayMs: Math.max(
      retryMinDelay,
      positiveInt(
        opts.graderRetryMaxDelayMs,
        DEFAULT_GRADER_RETRY_MAX_DELAY_MS
      )
    ),
  };
}

/**
 * Decide whether the compressed request is large enough to earn fan-out.
 * `contextTokens` is the whole A request (memory + recent turns + system +
 * tools), matching the corrected M1c measurement contract.
 */
export function abGateDecision(
  model: string,
  contextTokens: number,
  opts: ResolvedAbRoutingOptions
): AbGateDecision {
  if (opts.forceComparison) {
    return { compare: true, reason: "forced", contextTokens };
  }
  const prior = opts.effectiveContextTokens(model);
  if (prior === undefined) {
    return {
      compare: opts.sampleWhenNoPrior,
      reason: opts.sampleWhenNoPrior ? "sample-no-prior" : "skip-no-prior",
      contextTokens,
    };
  }
  const thresholdTokens = Math.floor(prior * opts.gateFraction);
  return {
    compare: contextTokens >= thresholdTokens,
    reason:
      contextTokens >= thresholdTokens ? "above-threshold" : "below-threshold",
    contextTokens,
    effectiveContextTokens: prior,
    thresholdTokens,
  };
}

/** Bootstrap priors copied from the monitoring study; unknown models sample. */
export function effectiveContextForModel(model: string): number | undefined {
  const normalized = model
    .replace(/^anthropic\//, "")
    .replace(/\[1m\]$/i, "")
    .toLowerCase();
  if (normalized.includes("claude-fable-5")) return 158_888;
  if (normalized.includes("claude-opus-4-8")) return 143_000;
  if (normalized.includes("claude-opus-4-6")) return 128_000;
  if (normalized.includes("claude-opus-4-5")) return 63_728;
  if (normalized.includes("claude-opus-4-1")) return 29_534;
  if (normalized.includes("claude-opus-4-20250514")) return 29_513;
  if (normalized.includes("claude-3-7-sonnet")) return 20_487;
  if (normalized.includes("claude-3-5-sonnet")) return 4_000;
  return undefined;
}

/** A and tie both keep the compact memory arm; only a valid B leaves it. */
export function winnerForVerdict(verdict: AbVerdict): AbWinner {
  return verdict === "B" ? "full" : "memory";
}

/**
 * Today the endpoint returns the unfolded index as the first non-system
 * processed message. Prefer a future explicit field at the call site, then use
 * this compatibility extraction.
 */
export function extractUnfoldedMemory(messages: Message[]): string {
  const first = messages.find((message) => message?.role !== "system");
  return first ? renderContent(first.content) : "";
}

export function buildFusionGraderBody(
  input: Omit<AbGradeInput, "signal">,
  graderModel: string,
  prefixChars: number
): Record<string, unknown> {
  return {
    model: graderModel,
    max_tokens: 4_096,
    thinking: { type: "adaptive" },
    system: buildFusionGraderSystemPrompt(),
    messages: [
      {
        role: "user",
        content: buildFusionGraderUserPrompt(input, prefixChars),
      },
    ],
    output_config: {
      format: {
        type: "json_schema",
        schema: FUSION_VERDICT_SCHEMA,
      },
    },
    stream: false,
  };
}

export function buildFusionGraderSystemPrompt(): string {
  return (
    "You are a rigorous answer-comparison grader for a memory-routing system. " +
    "You are given a user's question, a MEMORY, and two candidate answers.\n\n" +
    "WHAT THE MEMORY IS: not extra bonus context bolted onto the question. It " +
    "is a COMPRESSED, CURATED, post-processed distillation of the prior " +
    "conversation and history — a form of continual learning that abstracts " +
    "across time. Because it is compact, Answer A (the memory leg) runs on a " +
    "much SMALLER prompt than Answer B (which carries the full, uncompressed " +
    "history / no curated memory). That compactness is itself valuable: it " +
    "leaves the model more headroom to keep working and causes fewer KV-cache " +
    "misses, at lower cost. So the memory leg (A) is the PREFERRED default.\n\n" +
    "  - Answer A was written using the compressed memory.\n" +
    "  - Answer B was written from the full history, without the memory.\n" +
    "Both answers may be truncated to a prefix — judge on substance so far, " +
    "and do NOT penalise an answer merely for being cut off at the marker.\n\n" +
    "Score them PAIRWISE across the fusion rubric: consensus points (where " +
    "they agree), contradictions (where they disagree — one is likely wrong), " +
    "partial coverage, unique insights from each, and blind spots BOTH " +
    "missed. Then choose the verdict, with the memory leg favoured:\n" +
    "  - 'A'  — the memory answer is BETTER: the curated memory measurably " +
    "improved the answer.\n" +
    "  - 'tie' — the answers are EQUIVALENT in quality: the memory neither " +
    "clearly helped nor hurt. This is FINE and still favours the memory leg, " +
    "because it delivered the same quality with far less context. Do NOT hold " +
    "it against A that the memory 'added nothing new' — equal quality is a " +
    "memory win, not a reason to pick B.\n" +
    "  - 'B'  — the no-memory answer is MATERIALLY better: e.g. the memory was " +
    "stale, wrong, or actively misled A, or it omitted something essential " +
    "that the full history gave B. The bar for B is HIGH, because choosing B " +
    "means giving up the memory leg's headroom / cache / cost advantage.\n" +
    "Don't split hairs — a downstream router must not flip on noise."
  );
}

export function buildFusionGraderUserPrompt(
  input: Omit<AbGradeInput, "signal">,
  prefixChars: number
): string {
  const question = tailExcerpt(input.question, INPUT_EXCERPT_CHARS);
  const memory = input.unfoldedMemory.trim() || "(no memory was available)";
  const a = truncateToPrefix(input.memoryResponse, prefixChars);
  const b = truncateToPrefix(input.fullResponse, prefixChars);
  return (
    `## USER QUESTION (excerpt)\n${question}\n\n` +
    `## MEMORY (compressed, curated history) available to Answer A\n${memory}\n\n` +
    `## ANSWER A (memory leg — small compressed-memory prompt)\n${a}\n\n` +
    `## ANSWER B (no-memory leg — full uncompressed history)\n${b}\n\n` +
    "Grade A vs B per the rubric and return the structured verdict, " +
    "remembering the memory leg (A) is the preferred default."
  );
}

/** Parse the assistant JSON text emitted by Anthropic structured output. */
export function parseFusionVerdictResponse(value: unknown): FusionVerdict | null {
  if (!value || typeof value !== "object") return null;
  const content = (value as Record<string, unknown>).content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter(
      (block): block is Record<string, unknown> =>
        !!block && typeof block === "object" && block.type === "text"
    )
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
  if (!text) return null;
  try {
    return validateFusionVerdict(JSON.parse(text));
  } catch {
    return null;
  }
}

export function validateFusionVerdict(value: unknown): FusionVerdict | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (obj.verdict !== "A" && obj.verdict !== "B" && obj.verdict !== "tie") {
    return null;
  }
  if (typeof obj.reasoning !== "string") return null;
  if (typeof obj.materially_different !== "boolean") return null;
  if (obj.materially_different !== (obj.verdict !== "tie")) return null;
  if (
    !obj.metrics ||
    typeof obj.metrics !== "object" ||
    Array.isArray(obj.metrics)
  ) {
    return null;
  }
  const metrics = obj.metrics as Record<string, unknown>;
  const normalizedMetrics = {
    consensus_points: requiredStringArray(metrics.consensus_points),
    contradictions: requiredStringArray(metrics.contradictions),
    partial_coverage: requiredStringArray(metrics.partial_coverage),
    unique_insights_a: requiredStringArray(metrics.unique_insights_a),
    unique_insights_b: requiredStringArray(metrics.unique_insights_b),
    blind_spots: requiredStringArray(metrics.blind_spots),
  };
  if (Object.values(normalizedMetrics).some((items) => items === null)) {
    return null;
  }
  return {
    verdict: obj.verdict,
    materially_different: obj.materially_different,
    reasoning: obj.reasoning,
    metrics: normalizedMetrics as FusionMetrics,
  };
}

function renderContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const item = part as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") return item.text;
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .filter(Boolean)
    .join("\n");
}

function tailExcerpt(text: string, maxChars: number): string {
  const normalized = (text || "").trim();
  if (normalized.length <= maxChars) return normalized;
  return `…[earlier turns elided]\n${normalized.slice(-maxChars)}`;
}

function truncateToPrefix(text: string, prefixChars: number): string {
  if (text.length <= prefixChars) return text;
  return text.slice(0, prefixChars) + GRADING_TRUNCATION_MARKER;
}

function requiredStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value as string[];
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

const STRING_ARRAY_SCHEMA = {
  type: "array",
  items: { type: "string" },
} as const;

const FUSION_VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    metrics: {
      type: "object",
      additionalProperties: false,
      properties: {
        consensus_points: {
          ...STRING_ARRAY_SCHEMA,
          description: "Points where A and B agree — the reliable core.",
        },
        contradictions: {
          ...STRING_ARRAY_SCHEMA,
          description:
            "Points where A and B directly disagree (one is likely wrong).",
        },
        partial_coverage: {
          ...STRING_ARRAY_SCHEMA,
          description:
            "Points one answer made that the other only partially made.",
        },
        unique_insights_a: {
          ...STRING_ARRAY_SCHEMA,
          description:
            "Substantive points only the memory-leg answer (A) surfaced.",
        },
        unique_insights_b: {
          ...STRING_ARRAY_SCHEMA,
          description:
            "Substantive points only the no-memory-leg answer (B) surfaced.",
        },
        blind_spots: {
          ...STRING_ARRAY_SCHEMA,
          description:
            "Relevant points both answers missed (feeds fused insights).",
        },
      },
      required: [
        "consensus_points",
        "contradictions",
        "partial_coverage",
        "unique_insights_a",
        "unique_insights_b",
        "blind_spots",
      ],
    },
    verdict: {
      type: "string",
      enum: ["A", "B", "tie"],
      description:
        "A when memory is better, tie for equal quality, and B only when " +
        "full history is materially better.",
    },
    materially_different: {
      type: "boolean",
      description:
        "True for a material A/B quality difference; false for a tie.",
    },
    reasoning: {
      type: "string",
      description: "One or two sentences justifying the verdict from the metrics.",
    },
  },
  required: ["metrics", "verdict", "materially_different", "reasoning"],
} as const;
