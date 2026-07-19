/**
 * Always-on request/timing log (append-only JSONL) for post-hoc incident
 * reconstruction — when a turn stalls for minutes we want a client-side
 * record without asking the user to relaunch with --debug.
 *
 * Hard constraints:
 * - NEVER throw and NEVER block the proxy path: every filesystem touch is
 *   wrapped in try/catch and writes are fire-and-forget (async appendFile
 *   with an ignored error callback). A broken log path degrades to silence.
 * - Append-only single file at ~/.claude-code-infinite/logs/requests.jsonl,
 *   with one rotation slot: if the file exceeds ~20MB at proxy startup it is
 *   renamed to requests.jsonl.1 (overwriting any previous .1).
 *
 * One JSON object per line. `ts` (ISO 8601) is stamped here so callers only
 * supply event fields. Token counts under `approxInputTokens` are a rough
 * bytes/4 chars→tokens proxy, NOT real tokenizer output — exact usage, when
 * the response format lets us extract it cheaply, lands under `usage`.
 */

import { appendFile, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AbGateReason } from "./ab-routing.js";
import { getConfigDir } from "./config.js";

const MAX_LOG_BYTES = 20 * 1024 * 1024; // rotate above ~20MB at startup
const APPROX_CHARS_PER_TOKEN = 4;

/** Rough bytes→tokens estimate (bytes/4). Label the result approximate. */
export function approxTokensFromBytes(bytes: number): number {
  return Math.round(bytes / APPROX_CHARS_PER_TOKEN);
}

export function defaultLogPath(): string {
  return join(getConfigDir(), "logs", "requests.jsonl");
}

export type TurnType =
  | "first-user"
  | "tool"
  | "tool-memory"
  | "followup-compressed"
  | "followup-ab-pending"
  | "followup-ab-failed"
  | "followup-ab-memory"
  | "followup-ab-full"
  | "followup-ab-spliced"
  | "followup-ab-recovered"
  | "followup-degraded"
  | "followup-client-closed"
  | "unparseable";

/** Real token usage parsed from Anthropic's response, when available. */
export interface UsageRecord {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

export interface ComparisonLegRecord {
  requestBytes: number;
  upstreamStatus?: number;
  ttfbMs?: number;
  firstContentMs?: number;
  usage?: UsageRecord;
  ended?: boolean;
  error?: string;
}

/** Outcome of one grader call (also logged under `ComparisonRecord.grader`). */
export interface GraderDiagnostic {
  model: string;
  ok: boolean;
  status?: number;
  usage?: UsageRecord;
  error?: string;
}

/** What the client actually received in speculative mode (vs `winner`). */
export type ComparisonDelivered =
  | "memory"
  | "full"
  | "spliced"
  | "recovered"
  | "none";

export type ComparisonInterrupt =
  | "none"
  | "spliced"
  | "deferred-then-spliced"
  | "blocked-tool-use"
  | "blocked-full-not-sse"
  | "late-verdict"
  | "recovered";

export interface ComparisonRecord {
  attempted: boolean;
  gateReason: AbGateReason;
  /** Conservative estimate for the whole memory-leg request, not tokenizer output. */
  approxContextTokens: number;
  contextTokenEstimate: "body-bytes/3";
  effectiveContextTokens?: number;
  thresholdTokens?: number;
  prefixChars?: number;
  prefixWaitMs?: number;
  gradeMs?: number;
  grader?: GraderDiagnostic;
  /** Grader attempts beyond the first (speculative shadow grading only). */
  graderRetries?: number;
  verdict?: "A" | "B" | "tie";
  /** What the verdict (or fallback) chose — may differ from `delivered`. */
  winner?: "memory" | "full";
  fallbackReason?: string;
  memoryLeg?: ComparisonLegRecord;
  fullLeg?: ComparisonLegRecord;
  loserAborted?: boolean;
  clientAborted?: boolean;
  deliveryOk?: boolean;
  /** Speculative delivery fields (absent in buffered mode). */
  speculative?: boolean;
  /** Forward start → first response byte written toward the client. */
  clientTtfbMs?: number;
  interrupt?: ComparisonInterrupt;
  /** Client-visible answer-text characters delivered before the splice. */
  spliceAtChars?: number;
  /** A B verdict arrived after the interrupt window closed; logged only. */
  verdictLate?: boolean;
  delivered?: ComparisonDelivered;
}

/**
 * One /v1/messages request through the proxy. Built up mutably as the request
 * flows through the forward path (the forwarders fill in upstream timing) and
 * written once when the response finishes. Fields that a given path can't
 * derive cheaply are simply omitted.
 */
export interface MessagesRecord {
  kind: "messages";
  turnType: TurnType;
  /** Body bytes as received from Claude Code. */
  requestBytes: number;
  model?: string;
  stream?: boolean;
  /** Body bytes actually sent to Anthropic (after notice strip / compression). */
  forwardedBytes?: number;
  /** forwardedBytes/4 — rough chars→tokens proxy, not a tokenizer count. */
  approxInputTokens?: number;
  /** Present when a blocking MemTree compress was attempted for this turn. */
  compress?: { ms: number; ok: boolean; timedOut: boolean };
  /** Present when live memory-vs-full routing was eligible for this turn. */
  comparison?: ComparisonRecord;
  upstreamStatus?: number;
  /** Forward start → first response byte from Anthropic. */
  ttfbMs?: number;
  /** Forward start → first upstream content_block_delta (SSE only). */
  firstContentMs?: number;
  /** Request received → response fully sent to Claude Code. */
  totalMs?: number;
  /** Legacy schema field; live response fabrication is disabled. */
  preludeFired?: boolean;
  usage?: UsageRecord;
}

/** One MemTree API call (blocking compress or background index). */
export interface MemtreeRecord {
  kind: "memtree";
  indexOnly: boolean;
  ms: number;
  ok: boolean;
  /** HTTP status; absent when the call died before a response (network/timeout). */
  status?: number;
  requestBytes: number;
}

/** A display-only notice was atomically claimed by one Claude Code hook. */
export interface NoticeRecord {
  kind: "notice";
  event: "claimed";
  via: "MessageDisplay" | "Stop";
}

export type RequestRecord = MessagesRecord | MemtreeRecord | NoticeRecord;

/** Structural logging seam retained for embedders and focused tests. */
export interface RequestLogSink {
  log(record: RequestRecord): void;
}

export class RequestLogger implements RequestLogSink {
  readonly path: string;
  private readonly pendingWrites = new Set<Promise<void>>();

  constructor(filePath?: string) {
    this.path = filePath ?? defaultLogPath();
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      rotateIfLarge(this.path);
    } catch {
      // Unwritable/odd log location: run silent, never break startup.
    }
  }

  /** Fire-and-forget append of one JSONL line. Never throws, never blocks. */
  log(record: RequestRecord): void {
    try {
      const line =
        JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const settle = () => {
        this.pendingWrites.delete(pending);
        finish();
      };
      this.pendingWrites.add(pending);
      try {
        appendFile(this.path, line, settle);
      } catch {
        settle();
      }
    } catch {
      // Serialization/scheduling failure — same policy.
    }
  }

  /**
   * Shutdown-only durability seam. Wait for already-scheduled appends without
   * making normal proxy logging synchronous; false means the bounded wait
   * expired. Callers should stop request producers before invoking this.
   */
  async flush(timeoutMs = 2_000): Promise<boolean> {
    const boundedMs =
      Number.isFinite(timeoutMs) && timeoutMs >= 0
        ? Math.floor(timeoutMs)
        : 2_000;
    const deadline = Date.now() + boundedMs;
    while (this.pendingWrites.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer: NodeJS.Timeout | undefined;
      const completed = await Promise.race([
        Promise.allSettled([...this.pendingWrites]).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), remaining);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!completed) return false;
    }
    return true;
  }
}

/**
 * Merge token usage out of a parsed SSE event into a record. Anthropic sends
 * input/cache counts on message_start and the final output count (plus
 * occasionally refreshed input counts) on message_delta.
 */
export function mergeUsageFromSseEvent(data: any, rec: MessagesRecord): void {
  const type = data?.type;
  if (type === "message_start") mergeUsage(data?.message?.usage, rec);
  else if (type === "message_delta") mergeUsage(data?.usage, rec);
}

/** Merge usage from a non-streaming /v1/messages JSON response body. */
export function mergeUsageFromJsonBody(body: Buffer, rec: MessagesRecord): void {
  try {
    mergeUsage(JSON.parse(body.toString("utf-8"))?.usage, rec);
  } catch {
    // Not the shape we expected — usage just stays absent.
  }
}

const USAGE_FIELDS = [
  "input_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
] as const;

function mergeUsage(usage: unknown, rec: MessagesRecord): void {
  if (!usage || typeof usage !== "object") return;
  for (const field of USAGE_FIELDS) {
    const value = (usage as Record<string, unknown>)[field];
    if (typeof value !== "number") continue;
    rec.usage = rec.usage ?? {};
    rec.usage[field] = value;
  }
}

/** Startup size protection: one rotation slot, old .1 is overwritten. */
function rotateIfLarge(path: string): void {
  try {
    if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // Missing file (fresh install) or unreadable — nothing to rotate.
  }
}
