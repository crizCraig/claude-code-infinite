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
/**
 * The most a lane waits for an index whose time left the server stated (a 413's
 * Retry-After): longer estimates refuse at once, and later ones extend a wait only to here.
 */
export declare const INDEX_WAIT_MAX_MS: number;
/** A stated time left is waited for this much longer (estimates run over: 2026-11-09). */
export declare const INDEX_WAIT_MARGIN_RATIO = 0.5;
export declare const INDEX_WAIT_MARGIN_MS: number;
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
    /** The server's estimate of the indexing left (seconds), when it stated one. */
    indexSecondsLeft?: number;
    /** The final refusal's text (refusal-reason.ts); FINAL_REFUSAL_MESSAGE when absent. */
    refusalMessage?: string;
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
    /** A wait's length when the server stated no time left. */
    private readonly indexWaitMs;
    private readonly indexWaitMaxMs;
    private readonly failures;
    /**
     * Lane -> when its index wait began and when it ends; `over` once it ended but the
     * strike table had no room to record the refusal (still refused, never extended).
     */
    private readonly indexWaits;
    /** Lane -> when it was last seen waiting for its index; a delivery does not clear it. */
    private readonly indexWaitSeen;
    constructor(capacity?: number, 
    /** A wait's length when the server stated no time left. */
    indexWaitMs?: number, indexWaitMaxMs?: number);
    fail(lane: string, context?: FallbackFailureContext): RouteFallbackError;
    /**
     * Note MemTree saying the lane's index is still catching up (a held request's 413):
     * starts the lane's wait, or extends it by the stated time left. False once waiting
     * can no longer pay off (the estimate is past the cap, the wait's deadline passed, or
     * the lane was refused), so a held request stops asking and is refused.
     */
    indexWaitOpen(lane: string, secondsLeft: number | undefined, now?: number): boolean;
    /**
     * indexWaitOpen, and when the lane's wait ends: its deadline (Infinity when no slot was
     * free to track it), or undefined once closed.
     */
    indexWaitDeadline(lane: string, secondsLeft: number | undefined, now?: number): number | undefined;
    /** Whether the lane is waiting for its index (a wait started, not yet ended). */
    indexWaiting(lane: string): boolean;
    /** Whether the lane waits for its index now, or did at any time from `since` on. */
    indexWaitSince(lane: string, since: number): boolean;
    /** The time left MemTree last stated for the lane's index wait, if any. */
    indexSecondsLeft(lane: string): number | undefined;
    /** Whether a stated time left is too long to wait for at all (refused at once). */
    hopeless(secondsLeft: number | undefined): boolean;
    succeeded(lane: string): void;
    /** The bounded three-strike episode: 503, 503, then 400 until delivery. */
    private strike;
    /**
     * A 503 while the lane's wait is within its deadline; a 400 once it passes, or at once
     * for a stated time left past the cap. The deadline is set when the wait starts (the
     * stated time plus a margin, else indexWaitMs); a later stated time may extend it up to
     * indexWaitMaxMs from the start, and only a delivery clears it: an expired wait becomes
     * a terminal strike state, and an active wait is never evicted. A lane already refused,
     * or arriving while every wait slot is active, gets no wait (undefined) and falls back
     * to the strikes.
     */
    private waitForIndex;
    /**
     * Start or extend the lane's wait: "open" while the index may still land in time,
     * "closed" once it may not (and the lane is refused until a delivery), "untracked"
     * when every wait slot is taken (the strikes decide).
     */
    private track;
    /** Note the lane waiting for its index at `now` (bounded: oldest first out). */
    private seen;
    private trackWait;
    /** When a wait begun at `started` ends, given the time left stated at `now`. */
    private deadline;
    private indexWaitError;
    /** Free the slots of waits past their deadline, keeping them refused. */
    private retireExpiredWaits;
    /**
     * End the lane's wait in the terminal strike state. If the strike table is full a wait
     * keeps its slot instead, marked over (still refused, never extended), so no lane can
     * be re-admitted with a fresh deadline; with neither, the refusal stands for this
     * request only.
     */
    private close;
}
/**
 * The one-line status a waiting turn shows (Claude Code prints a 503's message on its
 * retry line): how long the server expects, when it said.
 */
export declare function indexWaitStatus(secondsLeft: number | undefined): string;
/** "about 1 minute", "about 5 minutes" (whole minutes, rounded up). */
export declare function timeLeftText(seconds: number): string;
/**
 * The refusal while MemTree is paused (402): only compression could fit the
 * request, and a retry cannot pay, so it is final at once and outside the
 * strike episode (attempt 0). Paying lets the very next request compress.
 */
export declare function pausedRefusal(message: string): RouteFallbackError;
/**
 * The refusal while MemTree can't be reached (network-failure.ts): nothing says the request
 * can't fit, so it is retryable and outside the strike episode (attempt 0). No retry-after:
 * Claude Code backs off as for its own connection errors, giving the network time to return.
 */
export declare function unreachableRefusal(message: string): RouteFallbackError;
/** Refusals of one lane further apart than this start a new streak. */
export declare const SLOW_RETRY_WINDOW_MS: number;
/** Consecutive refusals in a streak before the "slow to answer" notice. */
export declare const SLOW_RETRY_NOTICE_AFTER = 2;
/**
 * Consecutive refusals per lane, for the notice that MemTree is slow to
 * answer. One refusal says nothing to the user (Claude Code retries it, and
 * the retry usually goes through); a repeat within SLOW_RETRY_WINDOW_MS
 * does, once per streak. A delivery ends the streak.
 */
export declare class RefusalStreaks {
    private readonly capacity;
    private readonly windowMs;
    private readonly lanes;
    constructor(capacity?: number, windowMs?: number);
    /**
     * Note a refusal of `lane`; true the one time its streak should show the
     * notice. A refusal that cannot show it (`canNotice` false) still counts
     * and leaves the notice to a later one of the streak.
     */
    refused(lane: string, now?: number, canNotice?: boolean): boolean;
    delivered(lane: string): void;
}
//# sourceMappingURL=route-fallback.d.ts.map