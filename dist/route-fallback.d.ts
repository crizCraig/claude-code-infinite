/** After attempting compression at the soft budget, forward input that fits
 * the model's native context together with its output reservation (the full
 * max_tokens, or a floor on Claude 4.5+: see outputReservation). */
export declare function fitsFallbackBudget(inputTokens: number, outputTokens: number, budgetTokens: number, contextTokens: number, model?: string): boolean;
export interface RouteFallbackError {
    status: 503 | 400;
    attempt: number;
    headers: Record<string, string>;
    body: {
        type: "error";
        error: {
            type: string;
            message: string;
        };
    };
}
/** How long a lane may wait for MemTree to finish indexing before refusing. */
export declare const INDEX_WAIT_DEADLINE_MS: number;
/** Seconds Claude Code waits between retries while the index catches up. */
export declare const INDEX_WAIT_RETRY_AFTER_SECONDS = 30;
export declare const FINAL_REFUSAL_MESSAGE: string;
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
export declare class RouteFallbackFailures {
    private readonly capacity;
    private readonly indexWaitMs;
    private readonly failures;
    /** Lane -> when its index wait began (its deadline is fixed from then). */
    private readonly indexWaits;
    constructor(capacity?: number, indexWaitMs?: number);
    fail(lane: string, context?: FallbackFailureContext): RouteFallbackError;
    succeeded(lane: string): void;
    /** The bounded three-strike episode: 503, 503, then 400 until delivery. */
    private strike;
    /**
     * A 503 while the lane's wait is within its deadline; a 400 once it passes.
     * The deadline is fixed when the wait starts and only a delivery clears it:
     * an expired wait becomes a terminal strike state, and an active wait is
     * never evicted. A lane already refused, or arriving while every wait slot
     * is active, gets no wait (undefined) and falls back to the strikes.
     */
    private waitForIndex;
    private indexWaitError;
    /** Free the slots of waits past their deadline, keeping them refused. */
    private retireExpiredWaits;
    /**
     * An expired wait's lane moves to the terminal strike state. If the strike
     * table is full the wait keeps its slot instead (still expired, still
     * refused), so no lane can be re-admitted with a fresh deadline.
     */
    private retire;
}
//# sourceMappingURL=route-fallback.d.ts.map