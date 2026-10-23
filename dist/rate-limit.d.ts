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
import type { IncomingHttpHeaders } from "node:http";
export type RateLimitKind = "plan_limit" | "busy";
export interface RateLimitInfo {
    kind: RateLimitKind;
    status: number;
    /** plan_limit: when it resets (epoch ms), when Anthropic said. */
    resetsAt?: number;
}
export declare const BUSY_NOTICE = "Anthropic is busy; Claude Code will retry.";
/** Busy, said after the fact (next prompt, exit): Claude Code's retries have run out or stopped. */
export declare const BUSY_AFTER_NOTICE = "Anthropic was busy; try again in a moment.";
/** A plan limit with no reset time is forgotten after this (the 5-hour window). */
export declare const UNKNOWN_RESET_TTL_MS: number;
export declare const PLAN_LIMIT_NOTICE = "You've hit your Claude plan's usage limit.";
/** A 429/529 from Anthropic, classified; null for any other status. */
export declare function rateLimitFromResponse(status: number | undefined, headers: IncomingHttpHeaders, now?: number): RateLimitInfo | null;
/** The line for a rate limit: the plan's reset in local time when known. */
export declare function rateLimitNoticeText(info: RateLimitInfo, now?: number, formatTime?: (ms: number, now: number) => string, 
/** Said after the turn ended (next prompt, exit) rather than as it happens. */
after?: boolean): string;
/** `3:00 PM` today; `Sat 3:00 PM` on another day (this machine's locale and time zone). */
export declare function localResetTime(ms: number, now: number): string;
/**
 * What ccc has said about rate limits this run. A limit stays current until
 * Anthropic answers a turn again (answered) or, for the plan limit, its reset.
 */
export declare class RateLimitNotices {
    private readonly clock;
    private current;
    private seenAt;
    private promptShown;
    constructor(clock?: () => number);
    /** A refusal of a turn's request; true when it starts a new episode (say it now). */
    observe(info: RateLimitInfo): boolean;
    /**
     * Anthropic answered a turn's request that reached ccc at `startedAt`: nothing
     * to say any more. One sent before the refusal (a subagent's, finishing late)
     * proves nothing about the limit, so it is ignored.
     */
    answered(startedAt?: number): void;
    /** For the next prompt: the plan limit on every prompt until it resets; busy once. */
    promptLine(): string | undefined;
    /** For ccc's exit: the limit still in force, if any. */
    exitLine(): string | undefined;
    private active;
}
//# sourceMappingURL=rate-limit.d.ts.map