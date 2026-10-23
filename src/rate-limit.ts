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

export const BUSY_NOTICE = "Anthropic is busy; Claude Code will retry.";
/** Busy, said after the fact (next prompt, exit): Claude Code's retries have run out or stopped. */
export const BUSY_AFTER_NOTICE = "Anthropic was busy; try again in a moment.";
/** A plan limit with no reset time is forgotten after this (the 5-hour window). */
export const UNKNOWN_RESET_TTL_MS = 5 * 3600 * 1000;
export const PLAN_LIMIT_NOTICE = "You've hit your Claude plan's usage limit.";

/** A 429/529 from Anthropic, classified; null for any other status. */
export function rateLimitFromResponse(
  status: number | undefined,
  headers: IncomingHttpHeaders,
  now: number = Date.now()
): RateLimitInfo | null {
  if (status !== 429 && status !== 529) return null;
  if (status === 429 && header(headers, "anthropic-ratelimit-unified-status") === "rejected") {
    return { kind: "plan_limit", status, resetsAt: resetTime(headers, now) };
  }
  return { kind: "busy", status };
}

/** The line for a rate limit: the plan's reset in local time when known. */
export function rateLimitNoticeText(
  info: RateLimitInfo,
  now: number = Date.now(),
  formatTime: (ms: number, now: number) => string = localResetTime,
  /** Said after the turn ended (next prompt, exit) rather than as it happens. */
  after = false
): string {
  if (info.kind === "busy") return after ? BUSY_AFTER_NOTICE : BUSY_NOTICE;
  if (info.resetsAt === undefined || info.resetsAt <= now) return PLAN_LIMIT_NOTICE;
  return `${PLAN_LIMIT_NOTICE} It resets at ${formatTime(info.resetsAt, now)}.`;
}

/** `3:00 PM` today; `Sat 3:00 PM` on another day (this machine's locale and time zone). */
export function localResetTime(ms: number, now: number): string {
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
  private current: RateLimitInfo | null = null;
  private seenAt = 0;
  private promptShown = false;

  constructor(private readonly clock: () => number = Date.now) {}

  /** A refusal of a turn's request; true when it starts a new episode (say it now). */
  observe(info: RateLimitInfo): boolean {
    // Resets a minute apart are one limit (retry-after counts down per refusal).
    const minute = (ms: number | undefined) => ms === undefined ? -1 : Math.round(ms / 60_000);
    const fresh = !this.current || this.current.kind !== info.kind ||
      minute(this.current.resetsAt) !== minute(info.resetsAt);
    this.current = info;
    this.seenAt = this.clock();
    if (fresh) this.promptShown = false;
    return fresh;
  }

  /** Anthropic answered a turn: nothing to say any more. */
  answered(): void {
    this.current = null;
  }

  /** For the next prompt: the plan limit on every prompt until it resets; busy once. */
  promptLine(): string | undefined {
    const info = this.active();
    if (!info || (info.kind === "busy" && this.promptShown)) return undefined;
    this.promptShown = true;
    return rateLimitNoticeText(info, this.clock(), localResetTime, true);
  }

  /** For ccc's exit: the limit still in force, if any. */
  exitLine(): string | undefined {
    const info = this.active();
    return info ? rateLimitNoticeText(info, this.clock(), localResetTime, true) : undefined;
  }

  private active(): RateLimitInfo | null {
    const info = this.current;
    const now = this.clock();
    const over = info?.kind === "plan_limit" && (info.resetsAt !== undefined
      ? info.resetsAt <= now : now - this.seenAt >= UNKNOWN_RESET_TTL_MS);
    if (over) this.current = null;
    return this.current;
  }
}

function resetTime(headers: IncomingHttpHeaders, now: number): number | undefined {
  const reset = Number(header(headers, "anthropic-ratelimit-unified-reset"));
  if (Number.isFinite(reset) && reset > 0) return reset * 1000;
  const retryAfter = Number(header(headers, "retry-after"));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? now + retryAfter * 1000 : undefined;
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim();
}
