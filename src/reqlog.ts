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
  | "tool-memory"
  /** Tool-route miss recovered: validated compressed bytes sent to Anthropic. */
  | "tool-recompressed"
  | "followup-compressed"
  | "followup-noop"
  /** Indexed response that carried no prior conversation; history forwarded. */
  | "followup-empty-memory"
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
  compress?: {
    /** Overall wall time of the compress step (all concurrent legs). */
    ms: number;
    /**
     * The compress call returned a result (canonical or legacy leg). NOT a
     * "forwarded compressed history" flag: the proxy can still discard the
     * result afterwards (no-op response, or indexed-but-empty memory) and
     * forward the full history — `turnType` (followup-noop /
     * followup-empty-memory vs followup-compressed) and `history.usable`
     * record what actually happened.
     */
    ok: boolean;
    /**
     * The CANONICAL leg consumed (roughly) the whole compress budget and
     * returned nothing — measured on that leg's own duration, so a slow
     * legacy probe never inflates `ms` into a false timeout. Can be true
     * alongside ok/legacyFallback when the concurrent legacy probe rescued
     * the turn.
     */
    timedOut: boolean;
    /** Canonical miss recovered from a pre-normalization signed-thinking index. */
    legacyFallback?: boolean;
  };
  /**
   * How much conversation the compressed response actually carried. Recorded
   * separately from `compress.ok` because a fully indexed response can still
   * return an empty conversation; this is the field that shows it.
   */
  history?: {
    retainedChars: number;
    priorHistoryChars: number;
    usable: boolean;
  };
  /**
   * Which memory-route lane this request keys to: the away-summary side
   * channel, a request carrying agent attribution, or the main thread. This
   * is what splits verbatim `tool` rows into main-miss vs subagent traffic
   * when evaluating recovery behaviour after the fact.
   */
  routeLane?: "main" | "away" | "agent";
  /**
   * Tool turns that missed their lane's route: "missing" (empty lane),
   * "rejected" (a route was present in this lane but unusable for this
   * request), or "replay" (the body was an exact replay of the request that
   * installed the route — a client retry after a pre-flush socket death —
   * forwarded verbatim with the route retained and no recovery attempt).
   * "rejected" covers every OTHER reason memoryRoutedToolBody refuses:
   * a changed system/prefix hash, a conversation that shrank below the
   * stored prefix, and an unexpected tool suffix shape. (An epoch-stale
   * route never reaches rejection: getMemoryRoute drops it on lookup, so
   * that case logs "missing".)
   * Absent means there was no applicable miss — hits and away-summary turns
   * never emit it. "none" is deliberately not a value.
   */
  routeMiss?: "missing" | "rejected" | "replay";
  /** Outcome of a best-effort tool-route miss recovery attempt. */
  routeRecovery?: {
    /**
     * Serialized non-system conversation bytes, measured once per attempt.
     * Absent when the miss was resolved without an attempt (kill switch off,
     * cooldown, or a lane that already spent its per-epoch budget).
     */
    conversationBytes?: number;
    outcome:
      | "compressed"
      | "failed"
      | "noop"
      | "unusable"
      | "no-gain"
      | "client-closed"
      /** Kill switch off: no attempt was made or measured. */
      | "disabled"
      /** A recent attempt returned null; the blocking wait was skipped. */
      | "cooldown"
      /**
       * This lane already spent its one blocking attempt this epoch; the
       * miss forwarded verbatim without another attempt.
       */
      | "spent"
      /**
       * The compressed result could not be serialized (e.g. V8 string-length
       * limit on a multi-megabyte body). Forwarded the original.
       */
      | "build-failed";
    /** Route candidate fate; only "compressed" outcomes carry it. */
    install?:
      | "installed"
      | "stale"
      | "prompt-pending"
      | "no-session"
      /**
       * The recovered forward never reached protocol-complete and the
       * downstream client had NOT aborted. Typically an upstream 5xx/529
       * or a truncated upstream stream, but any non-2xx of the compressed
       * forward lands here — including a plain 4xx, which is deliberately
       * non-arming for the fuse — as does proxy-shutdown teardown of an
       * in-flight recovery. Refunds the lane's blocking budget.
       */
      | "upstream-failed"
      /**
       * The upstream served the turn to protocol-complete but route
       * bookkeeping threw at an activation attempt (the protocol-complete
       * attempt, the delivered-settle retry, or both), so no route exists.
       * Releases the lane's reservation but does NOT refund. In the common
       * sub-case the client got its complete answer — a fast-tool abort
       * after message_stop lands here, not in "client-aborted" — so no
       * identical-body retry is coming, and the throw is not
       * upstream-health evidence. Rarer closes land here too: a socket
       * that dies before the accepted message_stop bytes flush (which
       * DOES retry the identical body) and an upstream-owned error
       * arriving after the data chunk that carried message_stop. A retry
       * finds its lane spent until the next human-turn re-grant — a
       * bounded degradation accepted because the closes are
       * indistinguishable at settle time and refunding them would fund
       * one blocking recompress per tool turn under a deterministic
       * activation throw.
       */
      | "activation-error"
      /**
       * The downstream client aborted mid-stream before protocol-complete.
       * Refunds exactly like upstream-failed (no route exists and the
       * client's identical-body retry is imminent) but is split out so
       * attempt-rate tripwires can tell client behavior from upstream
       * health.
       */
      | "client-aborted";
  };
  upstreamStatus?: number;
  /** The downstream client aborted before the response finished. */
  clientAborted?: true;
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
  /** Model sent for server-side budget resolution (compression calls only). */
  model?: string;
  /**
   * Response diagnostics, present on successful calls that reported usage.
   * `indexedTokens` (cached_tokens) is the prompt coverage of the index and
   * drives the success notice: flat coverage across turns means MemTree
   * indexed nothing new. `memoryChars` moves independently of it because the
   * index is unfolded per question.
   */
  indexedTokens?: number;
  rawPromptTokens?: number;
  memoryChars?: number;
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
