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
/**
 * The raised budget never goes past this (unless the normal one already does): Claude Code
 * waits ~180 s for response headers by the proxy's notes (2.1.319), though 2026-11-12's
 * refusals reached the user after 176-199 s. 240 s keeps the raise modest.
 */
export const SLOW_UPLOAD_MAX_BUDGET_MS = 240_000;
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
        if (!this.extended(sessionId, bytes))
            return budgetMs;
        return Math.max(budgetMs, Math.min(budgetMs * SLOW_UPLOAD_BUDGET_FACTOR, SLOW_UPLOAD_MAX_BUDGET_MS));
    }
    /** Whether the session's next compress of `bytes` gets the longer budget. */
    extended(sessionId, bytes) {
        if (sessionId === undefined || bytes < this.minBytes)
            return false;
        const at = this.timedOutAt.get(sessionId);
        return at !== undefined && this.now() - at < SLOW_UPLOAD_MEMORY_MS;
    }
    /** Note how a long-budget compress of `bytes` ended; true when it was a slow upload. */
    settled(sessionId, bytes, outcome) {
        if (sessionId === undefined)
            return false;
        if (outcome === "ok") {
            this.timedOutAt.delete(sessionId);
            return false;
        }
        if (outcome !== "timeout" || bytes < this.minBytes)
            return false;
        this.timedOutAt.delete(sessionId);
        this.timedOutAt.set(sessionId, this.now());
        while (this.timedOutAt.size > MAX_SESSIONS) {
            this.timedOutAt.delete(this.timedOutAt.keys().next().value);
        }
        return true;
    }
}
//# sourceMappingURL=slow-upload.js.map