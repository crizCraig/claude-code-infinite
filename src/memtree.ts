/**
 * Client for the polychat.co MemTree API (/v1/context_memory).
 *
 * Two modes, mirroring the server's lazy-compression path (cc_api.py):
 * - Tool turns: fire-and-forget indexing POST, off the response path.
 * - User turns: blocking compression call with a hard timeout; the caller
 *   degrades to transparent pass-through on any failure (including 402 —
 *   compression is the paid feature, the user's own Anthropic call is never
 *   gated on it). A 402 from either mode additionally records
 *   payment-required state (paymentRequiredDetail) so the proxy can tell the
 *   user WHY MemTree is off instead of implying a transient outage; any later
 *   successful call clears it (the user paid mid-session).
 *
 * Work is deduped per messages hash, not per HTTP attempt, so Claude Code
 * retries cannot amplify into repeated compression/indexing calls.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { RequestLogSink } from "./reqlog.js";
import {
  stripCcSystemReminders,
  type Message,
} from "./turns.js";

export const CLIENT_NAME = "cc-infinite";
// Sent on every MemTree call so the server can detect/warn stale clients
// (plan: "API versioning").
export const CLIENT_VERSION: string = createRequire(import.meta.url)(
  "../package.json"
).version;

// Hard budget for the blocking user-turn compression call. The abort clock covers
// the ENTIRE fetch — uploading the full conversation (multi-MB on long sessions) plus
// server-side compression — so this is a circuit breaker for a hung server, not a
// latency target. Override via CCC_COMPRESS_TIMEOUT_MS (read below).
const DEFAULT_COMPRESS_TIMEOUT_MS = 15000;
/** Indexing runs off the response path; give it room. */
const INDEX_TIMEOUT_MS = 120_000;
const DEDUPE_CACHE_MAX = 64;

export interface MemtreeOptions {
  baseUrl: string;
  apiKey: string;
  compressTimeoutMs?: number;
  debug?: boolean;
  /** Always-on JSONL diagnostics; every MemTree call logs one line. */
  reqlog?: RequestLogSink;
}

export interface CompressResult {
  /** Processed (compressed) messages from the server; system role may be included. */
  messages: Message[];
  /**
   * Optional explicit unfolded index for A/B grading. Older servers omit it;
   * callers fall back to the first non-system processed message, which is the
   * current server layout.
   */
  unfolded_memory?: string;
  usage?: unknown;
  /** Client-observed latency of the underlying HTTP call (survives retry dedupe). */
  clientLatencyMs?: number;
}

function usageRecord(result: CompressResult): Record<string, unknown> | null {
  return result.usage && typeof result.usage === "object"
    ? (result.usage as Record<string, unknown>)
    : null;
}

/**
 * Whether the server actually used indexed conversation history. A successful
 * context_memory response is not enough: while an index is still warming, the
 * endpoint deliberately returns the messages as-is with cached_tokens = 0.
 */
export function didMemtreeCompress(result: CompressResult): boolean {
  const usage = usageRecord(result);
  if (!usage) return false;
  const details = usage.prompt_tokens_details;
  if (!details || typeof details !== "object") return false;
  const cachedTokens = (details as Record<string, unknown>).cached_tokens;
  return (
    typeof cachedTokens === "number" &&
    Number.isFinite(cachedTokens) &&
    cachedTokens > 0
  );
}

/**
 * MemTree's informational estimate of the original, pre-consolidation prompt.
 * Newer servers include images as visual-token estimates and deliberately keep
 * this value separate from billable Context Memory usage.
 */
export function rawPromptTokenCount(
  result: CompressResult
): number | undefined {
  const rawPromptTokens = usageRecord(result)?.raw_prompt_tokens;
  return typeof rawPromptTokens === "number" &&
    Number.isFinite(rawPromptTokens) &&
    rawPromptTokens > 0
    ? rawPromptTokens
    : undefined;
}

export class MemtreeClient {
  private baseUrl: string;
  private apiKey: string;
  private compressTimeoutMs: number;
  private debug: boolean;
  private reqlog: RequestLogSink | undefined;
  /** messages-hash → in-flight/settled compression promise (retry dedupe). */
  private compressCache = new Map<string, Promise<CompressResult | null>>();
  /** messages-hashes already submitted for background indexing. */
  private indexedHashes = new Set<string>();
  /** In-flight index-only calls, tracked so shutdown cannot outrun their logs. */
  private backgroundIndexes = new Map<Promise<void>, AbortController>();
  /** Once draining begins, no later request may create another log producer. */
  private backgroundClosing = false;
  /** FastAPI `detail` text from the most recent 402, or null while paid. */
  private unpaidDetail: string | null = null;

  /**
   * Non-null when the server last answered 402 (unpaid MemTree key): the
   * server's human-readable detail text. Set by both compression and
   * background-indexing calls; cleared by any subsequent success.
   */
  get paymentRequiredDetail(): string | null {
    return this.unpaidDetail;
  }

  /**
   * The blocking-compress abort budget. Exposed so the proxy's request log
   * can label a failed compress that consumed (roughly) the whole budget as a
   * timeout rather than a fast server error.
   */
  get compressBudgetMs(): number {
    return this.compressTimeoutMs;
  }

  constructor(opts: MemtreeOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.compressTimeoutMs =
      opts.compressTimeoutMs ??
      Number(process.env.CCC_COMPRESS_TIMEOUT_MS || DEFAULT_COMPRESS_TIMEOUT_MS);
    this.debug = opts.debug ?? false;
    this.reqlog = opts.reqlog;
  }

  static hashMessages(messages: Message[]): string {
    return createHash("sha256")
      .update(JSON.stringify(messages))
      .digest("hex");
  }

  /**
   * Blocking user-turn compression. Returns null on ANY failure (timeout,
   * network, 4xx/5xx including 402) — the caller must degrade to passthrough.
   * On 402 the failure is additionally recorded in paymentRequiredDetail so
   * the caller can distinguish "unpaid" from "outage".
   */
  compress(
    hash: string,
    messages: Message[],
    modelContextLimit: number,
    signal?: AbortSignal
  ): Promise<CompressResult | null> {
    const cached = this.compressCache.get(hash);
    if (cached) return cached;

    const promise = this.callContextMemory(messages, modelContextLimit, {
      timeoutMs: this.compressTimeoutMs,
      signal,
    }).catch((err) => {
      this.log(`compression failed: ${err?.message ?? err}`);
      // Don't cache failures — drop the entry so retries (e.g. Claude Code's
      // automatic retry of an identical request) hit the server again.
      if (this.compressCache.get(hash) === promise) {
        this.compressCache.delete(hash);
      }
      return null;
    });

    this.remember(hash, promise);
    return promise;
  }

  /**
   * Fire-and-forget background indexing for tool turns. Keeps the server index
   * fed during tool loops; adds zero latency to the response path.
   */
  indexInBackground(
    hash: string,
    messages: Message[],
    modelContextLimit: number
  ): void {
    if (this.backgroundClosing) return;
    if (this.indexedHashes.has(hash)) return;
    this.indexedHashes.add(hash);
    if (this.indexedHashes.size > DEDUPE_CACHE_MAX) {
      const first = this.indexedHashes.values().next().value;
      if (first !== undefined) this.indexedHashes.delete(first);
    }

    const stripped = stripCcSystemReminders(messages);
    const controller = new AbortController();
    const operation = this.callContextMemory(stripped, modelContextLimit, {
      timeoutMs: INDEX_TIMEOUT_MS,
      indexOnly: true,
      signal: controller.signal,
    })
      .then(
        () => undefined,
        (err) => {
          this.log(`background indexing failed (ignored): ${err?.message ?? err}`);
        }
      )
      .finally(() => {
        this.backgroundIndexes.delete(operation);
      });
    this.backgroundIndexes.set(operation, controller);
    void operation;
  }

  /**
   * Stop accepting background indexes and wait boundedly for those already in
   * flight. Calls still running after the grace period are aborted, and this
   * method does not return until their final request-log records are produced.
   * The boolean is true for a graceful drain and false when abort was needed.
   */
  async drainBackground(timeoutMs = 2_000): Promise<boolean> {
    this.backgroundClosing = true;
    if (this.backgroundIndexes.size === 0) return true;

    const boundedMs =
      Number.isFinite(timeoutMs) && timeoutMs >= 0
        ? Math.floor(timeoutMs)
        : 2_000;
    const pending = [...this.backgroundIndexes.keys()];
    let timer: NodeJS.Timeout | undefined;
    const completed = await Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), boundedMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (completed) return true;

    for (const controller of this.backgroundIndexes.values()) {
      controller.abort();
    }
    await Promise.allSettled([...this.backgroundIndexes.keys()]);
    return false;
  }

  private remember(hash: string, promise: Promise<CompressResult | null>) {
    this.compressCache.set(hash, promise);
    if (this.compressCache.size > DEDUPE_CACHE_MAX) {
      const first = this.compressCache.keys().next().value;
      if (first !== undefined) this.compressCache.delete(first);
    }
  }

  private async callContextMemory(
    messages: Message[],
    modelContextLimit: number,
    opts: { timeoutMs: number; indexOnly?: boolean; signal?: AbortSignal }
  ): Promise<CompressResult | null> {
    const body: Record<string, unknown> = {
      messages,
      model_context_limit: modelContextLimit,
    };
    // Server may ignore this until the index-only endpoint mode ships
    // (plan Phase 2.2); harmless extra field either way.
    if (opts.indexOnly) body.index_only = true;
    const payload = JSON.stringify(body);

    const started = Date.now();
    let status: number | undefined;
    let ok = false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, opts.timeoutMs);
    timeout.unref();
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
    try {
      const response = await fetch(`${this.baseUrl}/v1/context_memory`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "x-client": CLIENT_NAME,
          "x-client-version": CLIENT_VERSION,
        },
        body: payload,
        signal: controller.signal,
      });
      status = response.status;

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        if (response.status === 402) {
          this.unpaidDetail = extract402Detail(text);
        }
        throw new Error(
          `context_memory ${response.status}: ${text.slice(0, 300)}`
        );
      }

      const json = (await response.json()) as CompressResult;
      if (!Array.isArray(json.messages) || json.messages.length === 0) {
        throw new Error("context_memory returned no messages");
      }
      const clientLatencyMs = Date.now() - started;
      this.unpaidDetail = null; // a success proves the key is paid (again)
      ok = true;
      this.log(
        `context_memory ok in ${clientLatencyMs}ms ` +
          `(${messages.length} → ${json.messages.length} messages` +
          `${opts.indexOnly ? ", index-only" : ""})`
      );
      return { ...json, clientLatencyMs };
    } finally {
      clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", abort);
      // One JSONL line per MemTree call, success or failure; `status` stays
      // absent when the call never got a response (network error/timeout).
      this.reqlog?.log({
        kind: "memtree",
        indexOnly: opts.indexOnly === true,
        ms: Date.now() - started,
        ok,
        status,
        requestBytes: Buffer.byteLength(payload),
      });
    }
  }

  private log(msg: string) {
    if (this.debug) console.error(`[ccc proxy] ${msg}`);
  }
}

/** 402 bodies are FastAPI JSON: {"detail": "<human-readable payment text>"}. */
function extract402Detail(bodyText: string): string {
  try {
    const detail = JSON.parse(bodyText)?.detail;
    if (typeof detail === "string" && detail.trim()) return detail.trim();
  } catch {
    // non-JSON 402 body — fall through to the generic text
  }
  return "Payment required";
}
