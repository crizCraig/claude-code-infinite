/**
 * Short checkout link for an unpaid MemTree key.
 *
 * POST /v1/payment/link (authenticated with the MemTree key) answers
 * `{url: "https://app.polychat.co/p/Ab3xY9…", plan, monthly_price_usd, reason, expires_at}`.
 * The link opens Stripe Checkout for the key's own account with no sign-in, so the
 * wrong-account and signed-out detours of the old `/payment?user_id=…` link go away.
 * It works for an hour; the cache below fetches a new one when the old one is about
 * to expire.
 *
 * Servers without the endpoint (404), timeouts and odd bodies all mean "no link":
 * callers fall back to the status probe's `/payment?…` link, exactly as before.
 */
export declare const PAYMENT_LINK_PATH = "/v1/payment/link";
/** A link this close to expiry is replaced before it is shown or opened. */
export declare const PAYMENT_LINK_REFRESH_MARGIN_MS: number;
/** After a failed fetch (old server, outage), wait this long before asking again. */
export declare const PAYMENT_LINK_RETRY_MS: number;
export declare const PAYMENT_LINK_TIMEOUT_MS = 2000;
export declare const REASON_FREE_CREDIT_USED = "free_credit_used";
export declare const REASON_PLAN_LIMIT = "plan_limit";
export type PaymentLink = {
    url: string;
    /** Plan name to show, e.g. "Starter". */
    plan: string;
    /** Monthly price in US dollars, e.g. 5. */
    monthlyPriceUsd: number;
    /** Why MemTree is paused (REASON_*), or null when the server did not say. */
    reason: string | null;
    /** Epoch ms after which the link no longer works, or null when unknown. */
    expiresAt: number | null;
};
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type PaymentLinkFetchOptions = {
    baseUrl: string;
    apiKey: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
};
/** Ask the server for a short link; null on any failure. Never throws. */
export declare function fetchPaymentLink(opts: PaymentLinkFetchOptions): Promise<PaymentLink | null>;
/** Validate the endpoint's body; null unless it carries a usable short link. */
export declare function parsePaymentLink(body: unknown): PaymentLink | null;
/** Whether `link` can still be shown or opened (not within the margin of expiring). */
export declare function paymentLinkFresh(link: PaymentLink, now?: number): boolean;
/** "$5", "$7.50": whole dollars without cents. */
export declare function formatUsd(amount: number): string;
/**
 * One process's short link: fetched on demand, reused while fresh, refetched near
 * expiry, and not asked for again for PAYMENT_LINK_RETRY_MS after a failure (so an
 * old server's 404 costs one request, not one per 402).
 */
export declare class PaymentLinkCache {
    private readonly fetchLink;
    private readonly now;
    private link;
    private inFlight;
    private failedAt;
    constructor(fetchLink: () => Promise<PaymentLink | null>, now?: () => number);
    /** The cached link while fresh, else null (never fetches). */
    current(): PaymentLink | null;
    /** A fresh link: the cached one, or one fetch shared by concurrent callers. */
    get(): Promise<PaymentLink | null>;
    /** Wait at most `ms` for a fetch already in flight; resolves at once when none is. */
    settled(ms: number): Promise<void>;
}
//# sourceMappingURL=payment-link.d.ts.map