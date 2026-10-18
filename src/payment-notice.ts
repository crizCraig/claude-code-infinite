/**
 * In-session notice for an unpaid MemTree key (the server answered 402).
 *
 * ccc never gates the user's own Anthropic call on MemTree: on 402 the turn
 * goes out uncompressed. Without a visible reason, users kept working for
 * hours on uncompressed sessions and never learned why, so the notice says
 * what stopped, how to turn it back on (the subscribe link), and that the
 * session itself carries on.
 *
 * It is throttled: shown on the first 402 of a session, then at most once per
 * PAYMENT_NOTICE_INTERVAL_MS, and again when a session is resumed. A 402
 * typically repeats on every request, so an unthrottled notice would spam
 * every turn.
 */

import { sanitizeNoticeDetail } from "./notices.js";
import {
  extractPaymentUrl,
  FALLBACK_SUBSCRIBE_URL,
  withCheckoutSource,
} from "./payment-gate.js";

/**
 * Re-show interval. Long enough that a busy session sees it a couple of times
 * an hour at most; short enough that someone who keeps working uncompressed
 * is reminded why. Time-based rather than turn-based: fast tool-heavy turns
 * would otherwise make a per-N-turns throttle fire every few minutes.
 */
export const PAYMENT_NOTICE_INTERVAL_MS = 30 * 60 * 1000;

export const PAYMENT_PAUSED_HEADLINE =
  "⚠ MemTree compression is paused: usage limit reached. Subscribe to turn it back on:";
export const PAYMENT_CONTINUES_LINE =
  "Your session continues uncompressed.";
export const PAYMENT_PAGE_LABEL = "Your MemTree so far:";
/** What a paused key means, in the refusal and the command replies. */
export const MEMTREE_PAUSED = "MemTree is paused (usage limit reached)";

/**
 * The API error text Claude Code shows when a paused session no longer fits
 * the model's window: only compression could fit it, so it says why, how to
 * resume, and the one way on that needs no MemTree. One line, bare URL.
 */
export function pausedRefusalMessage(detail: string): string {
  return `${MEMTREE_PAUSED}, so this long conversation can't be compressed to fit the ` +
    `model's context window. Subscribe to resume: ${subscribeUrlFromDetail(detail)} · ` +
    "or start fresh with /clear (your history stays in your MemTree).";
}

/** The `/memtree` help line and `/memtree-compact` reply while paused; `url` is styled by the caller. */
export function pausedCompactionText(url: string): string {
  return `${MEMTREE_PAUSED}, so compaction is unavailable. Subscribe to resume: ${url}`;
}

/**
 * The notice lines. URLs sit alone on indented lines (bare, so the terminal's
 * linkifier gets a clean link); the hook renderer styles only the text lines.
 */
export function paymentNoticeText(detail: string, memtreeUrl?: string): string {
  const lines = [PAYMENT_PAUSED_HEADLINE, `  ${subscribeUrlFromDetail(detail)}`];
  const account = sanitizeNoticeDetail(detail.split(/[\r\n]/, 1)[0] ?? "");
  lines.push(PAYMENT_CONTINUES_LINE);
  if (account) lines.push(account);
  if (memtreeUrl) lines.push(PAYMENT_PAGE_LABEL, `  ${memtreeUrl}`);
  return lines.join("\n");
}

/**
 * The checkout link in a 402 detail (the server's payment prompt carries a
 * `/payment?user_id=…&user_email=…` link), tagged `source=ccc` like the
 * startup gate's; the pricing page when the detail has none.
 */
export function subscribeUrlFromDetail(detail: string): string {
  const url = extractPaymentUrl(detail);
  return url ? withCheckoutSource(trimUrlPunctuation(url)) : FALLBACK_SUBSCRIBE_URL;
}

/** When the payment notice may show again (one per ccc process). */
export class PaymentNoticeThrottle {
  private lastShownAt: number | undefined;

  constructor(
    private readonly intervalMs = PAYMENT_NOTICE_INTERVAL_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** Never shown yet, or the interval has passed since it last was. */
  due(): boolean {
    return this.lastShownAt === undefined || this.now() - this.lastShownAt >= this.intervalMs;
  }

  /** Call when a hook actually delivered the notice, not when it was queued. */
  markShown(): void {
    this.lastShownAt = this.now();
  }
}

/** Prose may end a link with a period or bracket; those are not part of it. */
function trimUrlPunctuation(url: string): string {
  return url.replace(/[).,;:!?'"\]]+$/, "");
}
