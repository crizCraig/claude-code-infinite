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
  | "followup-compressed"
  | "followup-degraded"
  | "unparseable";

/** Real token usage parsed from Anthropic's response, when available. */
export interface UsageRecord {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
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

export class RequestLogger {
  readonly path: string;

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
  log(record: MessagesRecord | MemtreeRecord): void {
    try {
      const line =
        JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
      appendFile(this.path, line, () => {
        // Write errors are swallowed: diagnostics must never break proxying.
      });
    } catch {
      // Serialization/scheduling failure — same policy.
    }
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
