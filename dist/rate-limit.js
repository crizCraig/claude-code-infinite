/**
 * Anthropic's 429/529 answers, told apart the way Claude Code tells them apart.
 *
 * - The Claude plan's usage limit: 429 with `anthropic-ratelimit-unified-status:
 *   rejected`; `anthropic-ratelimit-unified-reset` is when it lifts (epoch seconds).
 *   Claude Code does not retry into it.
 * - Busy: 529 (overloaded_error), or any other 429 (an API key's rate limit, a
 *   bare 429). Claude Code retries these itself, with its own backoff.
 *
 * ccc only reads the status and headers; the response reaches Claude Code
 * unchanged, so its retries and its own messages are untouched. What ccc adds is
 * one plain line: on the next prompt and when ccc exits (interactive; hooks can't
 * show anything on a turn an API error ended), or on stderr right away (print runs).
 */
export const BUSY_NOTICE = "Anthropic is busy; Claude Code will retry.";
export const PLAN_LIMIT_NOTICE = "You've hit your Claude plan's usage limit.";
/** A 429/529 from Anthropic, classified; null for any other status. */
export function rateLimitFromResponse(status, headers, now = Date.now()) {
    if (status !== 429 && status !== 529)
        return null;
    if (status === 429 && header(headers, "anthropic-ratelimit-unified-status") === "rejected") {
        return { kind: "plan_limit", status, resetsAt: resetTime(headers, now) };
    }
    return { kind: "busy", status };
}
/** The line for a rate limit: the plan's reset in local time when known. */
export function rateLimitNoticeText(info, now = Date.now(), formatTime = localResetTime) {
    if (info.kind === "busy")
        return BUSY_NOTICE;
    if (info.resetsAt === undefined || info.resetsAt <= now)
        return PLAN_LIMIT_NOTICE;
    return `${PLAN_LIMIT_NOTICE} It resets at ${formatTime(info.resetsAt, now)}.`;
}
/** `3:00 PM` today; `Sat 3:00 PM` on another day (this machine's locale and time zone). */
export function localResetTime(ms, now) {
    const at = new Date(ms);
    const sameDay = at.toDateString() === new Date(now).toDateString();
    return at.toLocaleString(undefined, {
        ...(sameDay ? {} : { weekday: "short" }),
        hour: "numeric",
        minute: "2-digit",
    });
}
/**
 * What ccc has said about rate limits this run. A limit stays current until
 * Anthropic answers a turn again (answered) or, for the plan limit, its reset.
 */
export class RateLimitNotices {
    clock;
    current = null;
    promptShown = false;
    constructor(clock = Date.now) {
        this.clock = clock;
    }
    /** A refusal of a turn's request; true when it starts a new episode (say it now). */
    observe(info) {
        const fresh = !this.current || this.current.kind !== info.kind ||
            this.current.resetsAt !== info.resetsAt;
        this.current = info;
        if (fresh)
            this.promptShown = false;
        return fresh;
    }
    /** Anthropic answered a turn: nothing to say any more. */
    answered() {
        this.current = null;
    }
    /** For the next prompt: the plan limit on every prompt until it resets; busy once. */
    promptLine() {
        const info = this.active();
        if (!info || (info.kind === "busy" && this.promptShown))
            return undefined;
        this.promptShown = true;
        return rateLimitNoticeText(info, this.clock());
    }
    /** For ccc's exit: the limit still in force, if any. */
    exitLine() {
        const info = this.active();
        return info ? rateLimitNoticeText(info, this.clock()) : undefined;
    }
    active() {
        const info = this.current;
        if (info?.kind === "plan_limit" && info.resetsAt !== undefined &&
            info.resetsAt <= this.clock()) {
            this.current = null;
        }
        return this.current;
    }
}
function resetTime(headers, now) {
    const reset = Number(header(headers, "anthropic-ratelimit-unified-reset"));
    if (Number.isFinite(reset) && reset > 0)
        return reset * 1000;
    const retryAfter = Number(header(headers, "retry-after"));
    return Number.isFinite(retryAfter) && retryAfter > 0 ? now + retryAfter * 1000 : undefined;
}
function header(headers, name) {
    const value = headers[name];
    return (Array.isArray(value) ? value[0] : value)?.trim();
}
//# sourceMappingURL=rate-limit.js.map