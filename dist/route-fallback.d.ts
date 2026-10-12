/** After attempting compression at the soft budget, forward input that fits
 * the model's native context together with its output reservation. */
export declare function fitsFallbackBudget(inputTokens: number, outputTokens: number, budgetTokens: number, contextTokens: number): boolean;
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
    /** Lane -> its index wait, least recently seen first. */
    private readonly indexWaits;
    constructor(capacity?: number, indexWaitMs?: number);
    fail(lane: string, context?: FallbackFailureContext): RouteFallbackError;
    succeeded(lane: string): void;
    /**
     * A 503 while the lane's wait is within its deadline; a 400 after it. An
     * expired wait stays refused while its lane keeps retrying, so retries
     * cannot reopen it.
     */
    private waitForIndex;
    /**
     * Make room for one more wait: drop waits idle for a whole deadline
     * (abandoned sessions and subagents), else the least recently seen one, so
     * a new lane always gets its wait.
     */
    private reclaimIndexWaits;
}
//# sourceMappingURL=route-fallback.d.ts.map