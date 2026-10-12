import { MEMTREE_COMPACT_COMMAND, MEMTREE_VIEW_COMMAND, SESSION_PLUGIN_NAME } from "./hooks.js";

/** After attempting compression at the soft budget, forward input that fits
 * the model's native context together with its output reservation. */
export function fitsFallbackBudget(
  inputTokens: number,
  outputTokens: number,
  budgetTokens: number,
  contextTokens: number,
): boolean {
  return [inputTokens, outputTokens, budgetTokens, contextTokens].every(
    (value) => Number.isFinite(value) && value >= 0,
  ) && inputTokens + outputTokens <= contextTokens;
}

export interface RouteFallbackError {
  status: 503 | 400;
  attempt: number;
  headers: Record<string, string>;
  body: { type: "error"; error: { type: string; message: string } };
}

/** How long a lane may wait for MemTree to finish indexing before refusing. */
export const INDEX_WAIT_DEADLINE_MS = 10 * 60_000;
/** Seconds Claude Code waits between retries while the index catches up. */
export const INDEX_WAIT_RETRY_AFTER_SECONDS = 30;

export const FINAL_REFUSAL_MESSAGE =
  "MemTree couldn't fit this request in the model's context window. If MemTree is " +
  `still indexing a recent change (see the session link from /${SESSION_PLUGIN_NAME}:` +
  `${MEMTREE_VIEW_COMMAND}), wait a minute and retry; otherwise run ` +
  `/${SESSION_PLUGIN_NAME}:${MEMTREE_COMPACT_COMMAND} or /clear.`;

export interface FallbackFailureContext {
  /**
   * This request's compress result did not fit only because MemTree's index
   * is behind the conversation (most of it still verbatim). Retries then wait
   * for indexing instead of spending the strike budget.
   */
  awaitingIndex?: boolean;
  now?: number;
}

/**
 * Claude Code 2.1.288 retries 503 itself, even with SDK maxRetries=0.
 * 529 has extra overload handling (including indefinite watchdog retries).
 * Use ordinary 503 retries and bound the episode in the proxy itself.
 * Successful delivery ends an episode; hook events and elapsed time do not.
 * An episode waiting on the index is bounded by wall clock instead of strikes.
 */
export class RouteFallbackFailures {
  private readonly failures = new Map<string, number>();
  /** Lane -> when its index wait began. */
  private readonly indexWaits = new Map<string, number>();

  constructor(
    private readonly capacity = 128,
    private readonly indexWaitMs = INDEX_WAIT_DEADLINE_MS,
  ) {}

  fail(lane: string, context: FallbackFailureContext = {}): RouteFallbackError {
    if (context.awaitingIndex) {
      const waiting = this.waitForIndex(lane, context.now ?? Date.now());
      if (waiting) return waiting;
    }
    const previous = this.failures.get(lane);
    // Fail closed when full rather than evicting a lane and granting it
    // another retry budget. A successful lane frees its slot.
    const attempt = previous === undefined && this.failures.size >= this.capacity
      ? 3 : Math.min((previous ?? 0) + 1, 3);
    if (previous !== undefined || this.failures.size < this.capacity) {
      this.failures.set(lane, attempt);
    }
    return attempt <= 2 ? retryError(attempt, "1", RETRY_MESSAGE) : refusal(attempt);
  }

  succeeded(lane: string): void {
    this.failures.delete(lane);
    this.indexWaits.delete(lane);
  }

  /** A 503 while the lane's wait is within its deadline; a 400 after it. */
  private waitForIndex(lane: string, now: number): RouteFallbackError | undefined {
    let started = this.indexWaits.get(lane);
    if (started === undefined) {
      // Full: no new waits, so the lane falls back to the bounded strikes.
      if (this.indexWaits.size >= this.capacity) return undefined;
      started = now;
      this.indexWaits.set(lane, started);
    }
    const attempt = this.failures.get(lane) ?? 0;
    if (now - started >= this.indexWaitMs) return refusal(Math.max(attempt, 3));
    return retryError(attempt, String(INDEX_WAIT_RETRY_AFTER_SECONDS), INDEX_WAIT_MESSAGE);
  }
}

const RETRY_MESSAGE =
  "MemTree could not produce a usable compressed request; retrying within a bounded limit.";
const INDEX_WAIT_MESSAGE =
  "MemTree is still indexing this conversation, so it does not fit the model's context " +
  "window yet; retrying once indexing catches up.";

function retryError(attempt: number, retryAfter: string, message: string): RouteFallbackError {
  return {
    status: 503,
    attempt,
    headers: { "retry-after": retryAfter, "x-should-retry": "true" },
    body: { type: "error", error: { type: "api_error", message } },
  };
}

function refusal(attempt: number): RouteFallbackError {
  return {
    status: 400,
    attempt,
    headers: { "x-should-retry": "false" },
    body: { type: "error", error: { type: "invalid_request_error", message: FINAL_REFUSAL_MESSAGE } },
  };
}
