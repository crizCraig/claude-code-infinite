/**
 * A longer compress budget for a session whose last large upload timed out.
 *
 * A compress with nothing else to send (no compressed prefix to ride, a whole request
 * over the window) gets the long budget, scaled by its upload (memtree.ts
 * COMPRESS_TIMEOUT_MS_PER_KIB). On a weak link a ~50 MB body still ran out of it: on
 * 2026-11-12 (session e32c1f3e, 23:35-23:51Z) six turns in a row each timed out at
 * 138.6 s and were refused, every retry with the same budget. So after such a timeout the
 * session's next compress of a large body gets SLOW_UPLOAD_BUDGET_FACTOR times the budget
 * (capped by the caller), and the refusal says so ("the next try waits up to ...").
 * A success, or SLOW_UPLOAD_MEMORY_MS without a retry, ends it.
 */
/** Uploads at least this large are slow on size alone (smaller timeouts are the server's). */
export declare const SLOW_UPLOAD_MIN_BYTES: number;
/** How much longer the next try may take. */
export declare const SLOW_UPLOAD_BUDGET_FACTOR = 2;
/** A timeout this old no longer raises the budget. */
export declare const SLOW_UPLOAD_MEMORY_MS: number;
export declare class SlowUploads {
    private readonly now;
    private readonly minBytes;
    private readonly timedOutAt;
    constructor(now?: () => number, minBytes?: number);
    /** The budget for a compress of `bytes` in `sessionId`, given its normal `budgetMs`. */
    budgetMs(sessionId: string | undefined, bytes: number, budgetMs: number): number;
    /** Whether the session's next compress of `bytes` gets the longer budget. */
    extended(sessionId: string | undefined, bytes: number): boolean;
    /** Note how a long-budget compress of `bytes` ended. */
    settled(sessionId: string | undefined, bytes: number, outcome: "ok" | "timeout" | "other"): void;
}
//# sourceMappingURL=slow-upload.d.ts.map