import { fitsNative, outputReservation } from "./request-sizing.js";
import { MEMTREE_COMPACT_COMMAND, MEMTREE_VIEW_COMMAND, SESSION_PLUGIN_NAME } from "./hooks.js";
/** After attempting compression at the soft budget, forward input that fits
 * the model's native context together with its output reservation (the full
 * max_tokens, or a floor on Claude 4.5+: see outputReservation). */
export function fitsFallbackBudget(inputTokens, outputTokens, budgetTokens, contextTokens, model) {
    return [inputTokens, outputTokens, budgetTokens, contextTokens].every((value) => Number.isFinite(value) && value >= 0) && fitsNative(inputTokens, { budget: budgetTokens, context: contextTokens,
        output: outputReservation(model, outputTokens) });
}
/** How long a lane may wait for MemTree to finish indexing before refusing. */
export const INDEX_WAIT_DEADLINE_MS = 10 * 60_000;
/**
 * The most a lane waits for an index whose time left the server stated (a 413's
 * Retry-After): longer estimates refuse at once, and later ones extend a wait only to here.
 */
export const INDEX_WAIT_MAX_MS = 15 * 60_000;
/** A stated time left is waited for this much longer (estimates run over: 2026-11-09). */
export const INDEX_WAIT_MARGIN_RATIO = 0.5;
export const INDEX_WAIT_MARGIN_MS = 2 * 60_000;
/** Seconds Claude Code waits between retries while the index catches up. */
export const INDEX_WAIT_RETRY_AFTER_SECONDS = 30;
export const FINAL_REFUSAL_MESSAGE = "MemTree couldn't fit this request in the model's context window. If MemTree is " +
    `still indexing a recent change (see the session link from /${SESSION_PLUGIN_NAME}:` +
    `${MEMTREE_VIEW_COMMAND}), wait a minute and retry; otherwise run ` +
    `/${SESSION_PLUGIN_NAME}:${MEMTREE_COMPACT_COMMAND} or /clear.`;
/**
 * Claude Code 2.1.288 retries 503 itself, even with SDK maxRetries=0.
 * 529 has extra overload handling (including indefinite watchdog retries).
 * Use ordinary 503 retries and bound the episode in the proxy itself.
 * Successful delivery ends an episode; hook events and elapsed time do not.
 * An episode waiting on the index is bounded by wall clock instead of strikes.
 */
export class RouteFallbackFailures {
    capacity;
    indexWaitMs;
    indexWaitMaxMs;
    failures = new Map();
    /**
     * Lane -> when its index wait began and when it ends; `over` once it ended but the
     * strike table had no room to record the refusal (still refused, never extended).
     */
    indexWaits = new Map();
    constructor(capacity = 128, 
    /** A wait's length when the server stated no time left. */
    indexWaitMs = INDEX_WAIT_DEADLINE_MS, indexWaitMaxMs = INDEX_WAIT_MAX_MS) {
        this.capacity = capacity;
        this.indexWaitMs = indexWaitMs;
        this.indexWaitMaxMs = indexWaitMaxMs;
    }
    fail(lane, context = {}) {
        if (context.awaitingIndex) {
            const waiting = this.waitForIndex(lane, context.now ?? Date.now(), context.indexSecondsLeft);
            if (waiting)
                return waiting;
        }
        return this.strike(lane);
    }
    /**
     * Note MemTree saying the lane's index is still catching up (a held request's 413):
     * starts the lane's wait, or extends it by the stated time left. False once waiting
     * can no longer pay off (the estimate is past the cap, the wait's deadline passed, or
     * the lane was refused), so a held request stops asking and is refused.
     */
    indexWaitOpen(lane, secondsLeft, now = Date.now()) {
        return this.track(lane, now, secondsLeft) !== "closed";
    }
    /**
     * indexWaitOpen, and when the lane's wait ends: its deadline (Infinity when no slot was
     * free to track it), or undefined once closed.
     */
    indexWaitDeadline(lane, secondsLeft, now = Date.now()) {
        const state = this.track(lane, now, secondsLeft);
        if (state === "closed")
            return undefined;
        return state === "untracked" ? Infinity : this.indexWaits.get(lane).deadline;
    }
    /** Whether the lane is waiting for its index (a wait started, not yet ended). */
    indexWaiting(lane) {
        const wait = this.indexWaits.get(lane);
        return wait !== undefined && !wait.over;
    }
    /** Whether a stated time left is too long to wait for at all (refused at once). */
    hopeless(secondsLeft) {
        return secondsLeft !== undefined && secondsLeft * 1000 > this.indexWaitMaxMs;
    }
    succeeded(lane) {
        this.failures.delete(lane);
        this.indexWaits.delete(lane);
    }
    /** The bounded three-strike episode: 503, 503, then 400 until delivery. */
    strike(lane) {
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
    /**
     * A 503 while the lane's wait is within its deadline; a 400 once it passes, or at once
     * for a stated time left past the cap. The deadline is set when the wait starts (the
     * stated time plus a margin, else indexWaitMs); a later stated time may extend it up to
     * indexWaitMaxMs from the start, and only a delivery clears it: an expired wait becomes
     * a terminal strike state, and an active wait is never evicted. A lane already refused,
     * or arriving while every wait slot is active, gets no wait (undefined) and falls back
     * to the strikes.
     */
    waitForIndex(lane, now, secondsLeft) {
        const state = this.track(lane, now, secondsLeft);
        if (state === "untracked")
            return undefined;
        return state === "open" ? this.indexWaitError(lane, secondsLeft) : refusal(3);
    }
    /**
     * Start or extend the lane's wait: "open" while the index may still land in time,
     * "closed" once it may not (and the lane is refused until a delivery), "untracked"
     * when every wait slot is taken (the strikes decide).
     */
    track(lane, now, secondsLeft) {
        if ((this.failures.get(lane) ?? 0) >= 3)
            return "closed";
        const wait = this.indexWaits.get(lane);
        if (wait?.over)
            return "closed";
        if (this.hopeless(secondsLeft))
            return this.close(lane);
        if (wait === undefined) {
            this.retireExpiredWaits(now);
            if (this.indexWaits.size >= this.capacity)
                return "untracked";
            this.indexWaits.set(lane, { started: now, deadline: this.deadline(now, now, secondsLeft) });
            return "open";
        }
        if (secondsLeft !== undefined) {
            wait.deadline = Math.max(wait.deadline, this.deadline(wait.started, now, secondsLeft));
        }
        return now < wait.deadline ? "open" : this.close(lane);
    }
    /** When a wait begun at `started` ends, given the time left stated at `now`. */
    deadline(started, now, secondsLeft) {
        if (secondsLeft === undefined)
            return started + this.indexWaitMs;
        const ms = secondsLeft * 1000;
        return Math.min(started + this.indexWaitMaxMs, now + ms + ms * INDEX_WAIT_MARGIN_RATIO + INDEX_WAIT_MARGIN_MS);
    }
    indexWaitError(lane, secondsLeft) {
        const retryAfter = secondsLeft === undefined ? INDEX_WAIT_RETRY_AFTER_SECONDS
            : Math.max(1, Math.min(INDEX_WAIT_RETRY_AFTER_SECONDS, Math.ceil(secondsLeft)));
        return retryError(this.failures.get(lane) ?? 0, String(retryAfter), indexWaitStatus(secondsLeft));
    }
    /** Free the slots of waits past their deadline, keeping them refused. */
    retireExpiredWaits(now) {
        for (const [lane, wait] of this.indexWaits) {
            if (now >= wait.deadline)
                this.close(lane);
        }
    }
    /**
     * End the lane's wait in the terminal strike state. If the strike table is full a wait
     * keeps its slot instead, marked over (still refused, never extended), so no lane can
     * be re-admitted with a fresh deadline; with neither, the refusal stands for this
     * request only.
     */
    close(lane) {
        if (this.failures.has(lane) || this.failures.size < this.capacity) {
            this.failures.set(lane, 3);
            this.indexWaits.delete(lane);
        }
        else {
            const wait = this.indexWaits.get(lane);
            if (wait)
                wait.over = true;
        }
        return "closed";
    }
}
const RETRY_MESSAGE = "MemTree could not produce a usable compressed request; retrying within a bounded limit.";
/**
 * The one-line status a waiting turn shows (Claude Code prints a 503's message on its
 * retry line): how long the server expects, when it said.
 */
export function indexWaitStatus(secondsLeft) {
    const left = secondsLeft === undefined ? "" : `, ${timeLeftText(secondsLeft)} left`;
    return `MemTree is catching up on this session's index${left}. ` +
        "This turn continues on its own once it's ready.";
}
/** "about 1 minute", "about 5 minutes" (whole minutes, rounded up). */
export function timeLeftText(seconds) {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return minutes === 1 ? "about 1 minute" : `about ${minutes} minutes`;
}
/**
 * The refusal while MemTree is paused (402): only compression could fit the
 * request, and a retry cannot pay, so it is final at once and outside the
 * strike episode (attempt 0). Paying lets the very next request compress.
 */
export function pausedRefusal(message) {
    return { ...refusal(0), body: { type: "error",
            error: { type: "invalid_request_error", message } } };
}
function retryError(attempt, retryAfter, message) {
    return {
        status: 503,
        attempt,
        headers: { "retry-after": retryAfter, "x-should-retry": "true" },
        body: { type: "error", error: { type: "api_error", message } },
    };
}
function refusal(attempt) {
    return {
        status: 400,
        attempt,
        headers: { "x-should-retry": "false" },
        body: {
            type: "error",
            error: { type: "invalid_request_error", message: FINAL_REFUSAL_MESSAGE },
        },
    };
}
/** Refusals of one lane further apart than this start a new streak. */
export const SLOW_RETRY_WINDOW_MS = 5 * 60_000;
/** Consecutive refusals in a streak before the "slow to answer" notice. */
export const SLOW_RETRY_NOTICE_AFTER = 2;
/**
 * Consecutive refusals per lane, for the notice that MemTree is slow to
 * answer. One refusal says nothing to the user (Claude Code retries it, and
 * the retry usually goes through); a repeat within SLOW_RETRY_WINDOW_MS
 * does, once per streak. A delivery ends the streak.
 */
export class RefusalStreaks {
    capacity;
    windowMs;
    lanes = new Map();
    constructor(capacity = 128, windowMs = SLOW_RETRY_WINDOW_MS) {
        this.capacity = capacity;
        this.windowMs = windowMs;
    }
    /**
     * Note a refusal of `lane`; true the one time its streak should show the
     * notice. A refusal that cannot show it (`canNotice` false) still counts
     * and leaves the notice to a later one of the streak.
     */
    refused(lane, now = Date.now(), canNotice = true) {
        const prior = this.lanes.get(lane);
        const streak = prior && now - prior.at <= this.windowMs
            ? prior : { count: 0, at: now, noticed: false };
        streak.count += 1;
        streak.at = now;
        this.lanes.delete(lane);
        if (this.capacity > 0) {
            while (this.lanes.size >= this.capacity)
                this.lanes.delete(this.lanes.keys().next().value);
            this.lanes.set(lane, streak);
        }
        if (!canNotice || streak.noticed || streak.count < SLOW_RETRY_NOTICE_AFTER)
            return false;
        streak.noticed = true;
        return true;
    }
    delivered(lane) {
        this.lanes.delete(lane);
    }
}
//# sourceMappingURL=route-fallback.js.map