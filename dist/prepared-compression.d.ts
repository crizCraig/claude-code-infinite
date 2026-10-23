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
export declare const COMPRESSION_RESERVE_TOKENS = 40000;
/** Preparing starts at this share of the trigger: 850k of 960k. */
export declare const PREPARE_START_RATIO: number;
/** And refreshes after this much growth (share of the trigger): 50k of 960k. */
export declare const PREPARE_REFRESH_RATIO: number;
/**
 * The size at which a request is compressed: the budget, or the window less
 * the reply's room when that is lower ("compress when the projected request
 * plus the reserve would exceed the window or the trigger").
 */
export declare function compressionTrigger(budgetTokens: number, contextTokens: number): number;
/** Where preparing starts for a trigger. */
export declare function prepareStartTokens(triggerTokens: number): number;
/** Growth after which a prepared prefix is refreshed. */
export declare function prepareRefreshTokens(triggerTokens: number): number;
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
export declare class PreparedCompressions<P> {
    private readonly ready;
    private readonly inFlight;
    /** The size and trigger of each session's last call, answered or not. */
    private readonly lastAttempt;
    /** Undefined until a prepare response says whether the server prepares. */
    private serverPrepares;
    /** Whether a request of `tokens` (under `triggerTokens`) should prepare now. */
    decide(sessionId: string, tokens: number, triggerTokens: number): PrepareDecision;
    /** Mark a call in flight for `sessionId`; false when one already is. */
    begin(sessionId: string, tokens: number, triggerTokens: number): boolean;
    /** End the session's call, storing what it prepared (undefined: nothing usable). */
    finish(sessionId: string, prepared: Prepared<P> | undefined): void;
    /** The server's answer to a prepare call: `prepared: true` or not. */
    noteServerSupport(prepares: boolean): void;
    get(sessionId: string): Prepared<P> | undefined;
    /**
     * Forget the session's prepared prefix and its refresh point (used,
     * superseded by a new stable prefix, or no longer a prefix of the history):
     * the next request past the start prepares afresh.
     */
    discard(sessionId: string): void;
    isInFlight(sessionId: string): boolean;
}
//# sourceMappingURL=prepared-compression.d.ts.map