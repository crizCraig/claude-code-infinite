/**
 * Prepared compression (polychat docs/context_memory_request_pipeline.md,
 * "Prepared compression").
 *
 * On the 1M-window models MemTree compresses a session at 960k, just under
 * where plain Claude Code would auto-compact. A tool result that lands near
 * that line (100k at 940k) used to wait on a blocking compress call. Instead,
 * once a session's main-thread request passes PREPARE_START (~850k), the proxy
 * asks MemTree in the background (`prepare: true`, fire and forget, one call
 * per session at a time) for the compressed prefix of the conversation so
 * far, and asks again every ~50k of growth. The turn that would cross the
 * trigger then sends that prefix plus the messages after it, with no compress
 * call; without a usable prepared prefix it compresses as before.
 *
 * This module holds the policy and the per-session bookkeeping; the proxy
 * owns the prefixes (their shape is its StablePrefix).
 */

/** Room left below the window for the reply (output and thinking). */
export const COMPRESSION_RESERVE_TOKENS = 40_000;
/** Preparing starts at this share of the trigger: 850k of 960k. */
export const PREPARE_START_RATIO = 850 / 960;
/** And refreshes after this much growth (share of the trigger): 50k of 960k. */
export const PREPARE_REFRESH_RATIO = 50 / 960;
/** Sessions whose prepared prefix is kept (LRU). */
const PREPARED_MAX_SESSIONS = 16;

/**
 * The size at which a request is compressed: the budget, or the window less
 * the reply's room when that is lower ("compress when the projected request
 * plus the reserve would exceed the window or the trigger").
 */
export function compressionTrigger(budgetTokens: number, contextTokens: number): number {
  const windowTrigger = contextTokens - COMPRESSION_RESERVE_TOKENS;
  return windowTrigger > 0 ? Math.min(budgetTokens, windowTrigger) : budgetTokens;
}

/** Where preparing starts for a trigger. */
export function prepareStartTokens(triggerTokens: number): number {
  return Math.floor(triggerTokens * PREPARE_START_RATIO);
}

/** Growth after which a prepared prefix is refreshed. */
export function prepareRefreshTokens(triggerTokens: number): number {
  return Math.floor(triggerTokens * PREPARE_REFRESH_RATIO);
}

/** A prepared prefix and the size of the request it was prepared at. */
export interface Prepared<P> {
  prefix: P;
  /** The planned size of the request that asked for it. */
  atTokens: number;
  /** The trigger it was prepared against; a change discards it. */
  triggerTokens: number;
}

/** What the planner's size says about preparing for a session. */
export type PrepareDecision = "prepare" | "too-small" | "in-flight" | "fresh" | "unsupported";

/** Per-session prepared prefixes and the background calls making them. */
export class PreparedCompressions<P> {
  private readonly ready = new Map<string, Prepared<P>>();
  private readonly inFlight = new Map<string, number>();
  /** The size and trigger of each session's last call, answered or not. */
  private readonly lastAttempt = new Map<string, { tokens: number; triggerTokens: number }>();
  /** Undefined until a prepare response says whether the server prepares. */
  private serverPrepares: boolean | undefined;

  /** Whether a request of `tokens` (under `triggerTokens`) should prepare now. */
  decide(sessionId: string, tokens: number, triggerTokens: number): PrepareDecision {
    if (this.serverPrepares === false) return "unsupported";
    if (!(tokens >= prepareStartTokens(triggerTokens)) || tokens >= triggerTokens) {
      return "too-small";
    }
    if (this.inFlight.has(sessionId)) return "in-flight";
    // A failed call waits for the same growth as a successful one: a MemTree
    // outage costs one background call per refresh step, not one per turn.
    const last = this.lastAttempt.get(sessionId);
    if (last && last.triggerTokens === triggerTokens &&
        tokens >= last.tokens && tokens < last.tokens + prepareRefreshTokens(triggerTokens)) {
      return "fresh";
    }
    return "prepare";
  }

  /** Mark a call in flight for `sessionId`; false when one already is. */
  begin(sessionId: string, tokens: number, triggerTokens: number): boolean {
    if (this.inFlight.has(sessionId)) return false;
    this.inFlight.set(sessionId, tokens);
    this.lastAttempt.delete(sessionId);
    this.lastAttempt.set(sessionId, { tokens, triggerTokens });
    while (this.lastAttempt.size > PREPARED_MAX_SESSIONS) {
      const oldest = this.lastAttempt.keys().next().value;
      if (oldest === undefined) break;
      this.lastAttempt.delete(oldest);
    }
    return true;
  }

  /** End the session's call, storing what it prepared (undefined: nothing usable). */
  finish(sessionId: string, prepared: Prepared<P> | undefined): void {
    this.inFlight.delete(sessionId);
    if (!prepared) return;
    this.ready.delete(sessionId);
    this.ready.set(sessionId, prepared);
    while (this.ready.size > PREPARED_MAX_SESSIONS) {
      const oldest = this.ready.keys().next().value;
      if (oldest === undefined) break;
      this.ready.delete(oldest);
    }
  }

  /** The server's answer to a prepare call: `prepared: true` or not. */
  noteServerSupport(prepares: boolean): void {
    this.serverPrepares = prepares;
  }

  get(sessionId: string): Prepared<P> | undefined {
    return this.ready.get(sessionId);
  }

  /**
   * Forget the session's prepared prefix and its refresh point (used,
   * superseded by a new stable prefix, or no longer a prefix of the history):
   * the next request past the start prepares afresh.
   */
  discard(sessionId: string): void {
    this.ready.delete(sessionId);
    this.lastAttempt.delete(sessionId);
  }

  isInFlight(sessionId: string): boolean {
    return this.inFlight.has(sessionId);
  }
}
