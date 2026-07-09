/**
 * Client for the polychat.co MemTree API (/v1/context_memory).
 *
 * Two modes, mirroring the server's lazy-compression path (cc_api.py):
 * - Tool turns: fire-and-forget indexing POST, off the response path.
 * - User turns: blocking compression call with a hard timeout; the caller
 *   degrades to transparent pass-through on any failure (including 402 —
 *   compression is the paid feature, the user's own Anthropic call is never
 *   gated on it).
 *
 * Work is deduped per messages hash, not per HTTP attempt, so Claude Code
 * retries cannot amplify into repeated compression/indexing calls.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
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
}

export interface CompressResult {
  /** Processed (compressed) messages from the server; system role may be included. */
  messages: Message[];
  usage?: unknown;
}

export class MemtreeClient {
  private baseUrl: string;
  private apiKey: string;
  private compressTimeoutMs: number;
  private debug: boolean;
  /** messages-hash → in-flight/settled compression promise (retry dedupe). */
  private compressCache = new Map<string, Promise<CompressResult | null>>();
  /** messages-hashes already submitted for background indexing. */
  private indexedHashes = new Set<string>();

  constructor(opts: MemtreeOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.compressTimeoutMs =
      opts.compressTimeoutMs ??
      Number(process.env.CCC_COMPRESS_TIMEOUT_MS || DEFAULT_COMPRESS_TIMEOUT_MS);
    this.debug = opts.debug ?? false;
  }

  static hashMessages(messages: Message[]): string {
    return createHash("sha256")
      .update(JSON.stringify(messages))
      .digest("hex");
  }

  /**
   * Blocking user-turn compression. Returns null on ANY failure (timeout,
   * network, 4xx/5xx including 402) — the caller must degrade to passthrough.
   */
  compress(
    hash: string,
    messages: Message[],
    modelContextLimit: number
  ): Promise<CompressResult | null> {
    const cached = this.compressCache.get(hash);
    if (cached) return cached;

    const promise = this.callContextMemory(messages, modelContextLimit, {
      timeoutMs: this.compressTimeoutMs,
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
    if (this.indexedHashes.has(hash)) return;
    this.indexedHashes.add(hash);
    if (this.indexedHashes.size > DEDUPE_CACHE_MAX) {
      const first = this.indexedHashes.values().next().value;
      if (first !== undefined) this.indexedHashes.delete(first);
    }

    const stripped = stripCcSystemReminders(messages);
    void this.callContextMemory(stripped, modelContextLimit, {
      timeoutMs: INDEX_TIMEOUT_MS,
      indexOnly: true,
    }).catch((err) => {
      this.log(`background indexing failed (ignored): ${err?.message ?? err}`);
    });
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
    opts: { timeoutMs: number; indexOnly?: boolean }
  ): Promise<CompressResult | null> {
    const body: Record<string, unknown> = {
      messages,
      model_context_limit: modelContextLimit,
    };
    // Server may ignore this until the index-only endpoint mode ships
    // (plan Phase 2.2); harmless extra field either way.
    if (opts.indexOnly) body.index_only = true;

    const started = Date.now();
    const response = await fetch(`${this.baseUrl}/v1/context_memory`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "x-client": CLIENT_NAME,
        "x-client-version": CLIENT_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `context_memory ${response.status}: ${text.slice(0, 300)}`
      );
    }

    const json = (await response.json()) as CompressResult;
    if (!Array.isArray(json.messages) || json.messages.length === 0) {
      throw new Error("context_memory returned no messages");
    }
    this.log(
      `context_memory ok in ${Date.now() - started}ms ` +
        `(${messages.length} → ${json.messages.length} messages` +
        `${opts.indexOnly ? ", index-only" : ""})`
    );
    return json;
  }

  private log(msg: string) {
    if (this.debug) console.error(`[ccc proxy] ${msg}`);
  }
}
