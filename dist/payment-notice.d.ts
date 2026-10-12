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
/**
 * Re-show interval. Long enough that a busy session sees it a couple of times
 * an hour at most; short enough that someone who keeps working uncompressed
 * is reminded why. Time-based rather than turn-based: fast tool-heavy turns
 * would otherwise make a per-N-turns throttle fire every few minutes.
 */
export declare const PAYMENT_NOTICE_INTERVAL_MS: number;
export declare const PAYMENT_PAUSED_HEADLINE = "\u26A0 MemTree compression is paused: usage limit reached. Subscribe to turn it back on:";
export declare const PAYMENT_CONTINUES_LINE = "Your session continues uncompressed.";
export declare const PAYMENT_PAGE_LABEL = "Your MemTree so far:";
/**
 * The notice lines. URLs sit alone on indented lines (bare, so the terminal's
 * linkifier gets a clean link); the hook renderer styles only the text lines.
 */
export declare function paymentNoticeText(detail: string, memtreeUrl?: string): string;
/**
 * The checkout link in a 402 detail (the server's payment prompt carries a
 * `/payment?user_id=…&user_email=…` link), tagged `source=ccc` like the
 * startup gate's; the pricing page when the detail has none.
 */
export declare function subscribeUrlFromDetail(detail: string): string;
/** When the payment notice may show again (one per ccc process). */
export declare class PaymentNoticeThrottle {
    private readonly intervalMs;
    private readonly now;
    private lastShownAt;
    constructor(intervalMs?: number, now?: () => number);
    /** Never shown yet, or the interval has passed since it last was. */
    due(): boolean;
    /** Call when a hook actually delivered the notice, not when it was queued. */
    markShown(): void;
}
//# sourceMappingURL=payment-notice.d.ts.map