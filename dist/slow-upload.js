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
export const SLOW_UPLOAD_MIN_BYTES = 20 * 1024 * 1024;
/** How much longer the next try may take. */
export const SLOW_UPLOAD_BUDGET_FACTOR = 2;
/** A timeout this old no longer raises the budget. */
export const SLOW_UPLOAD_MEMORY_MS = 30 * 60_000;
const MAX_SESSIONS = 128;
export class SlowUploads {
    now;
    minBytes;
    timedOutAt = new Map();
    constructor(now = Date.now, minBytes = SLOW_UPLOAD_MIN_BYTES) {
        this.now = now;
        this.minBytes = minBytes;
    }
    /** The budget for a compress of `bytes` in `sessionId`, given its normal `budgetMs`. */
    budgetMs(sessionId, bytes, budgetMs) {
        return this.extended(sessionId, bytes) ? budgetMs * SLOW_UPLOAD_BUDGET_FACTOR : budgetMs;
    }
    /** Whether the session's next compress of `bytes` gets the longer budget. */
    extended(sessionId, bytes) {
        if (sessionId === undefined || bytes < this.minBytes)
            return false;
        const at = this.timedOutAt.get(sessionId);
        return at !== undefined && this.now() - at < SLOW_UPLOAD_MEMORY_MS;
    }
    /** Note how a long-budget compress of `bytes` ended. */
    settled(sessionId, bytes, outcome) {
        if (sessionId === undefined)
            return;
        if (outcome === "ok") {
            this.timedOutAt.delete(sessionId);
            return;
        }
        if (outcome !== "timeout" || bytes < this.minBytes)
            return;
        this.timedOutAt.delete(sessionId);
        this.timedOutAt.set(sessionId, this.now());
        while (this.timedOutAt.size > MAX_SESSIONS) {
            this.timedOutAt.delete(this.timedOutAt.keys().next().value);
        }
    }
}
//# sourceMappingURL=slow-upload.js.map