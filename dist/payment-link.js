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
export const PAYMENT_LINK_PATH = "/v1/payment/link";
/** A link this close to expiry is replaced before it is shown or opened. */
export const PAYMENT_LINK_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** After a failed fetch (old server, outage), wait this long before asking again. */
export const PAYMENT_LINK_RETRY_MS = 10 * 60 * 1000;
export const PAYMENT_LINK_TIMEOUT_MS = 2000;
export const REASON_FREE_CREDIT_USED = "free_credit_used";
export const REASON_PLAN_LIMIT = "plan_limit";
// The link must be our short path: a hostile or broken body can't put an arbitrary
// URL (or terminal controls) on screen or into `open`.
const SHORT_LINK_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?\/p\/[A-Za-z0-9]{12,64}$/;
const PLAN_RE = /^[A-Za-z0-9 %.+-]{1,40}$/;
/** Ask the server for a short link; null on any failure. Never throws. */
export async function fetchPaymentLink(opts) {
    try {
        const res = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl.replace(/\/$/, "")}${PAYMENT_LINK_PATH}`, {
            method: "POST",
            headers: { authorization: `Bearer ${opts.apiKey}`, ...opts.headers },
            signal: AbortSignal.timeout(opts.timeoutMs ?? PAYMENT_LINK_TIMEOUT_MS),
        });
        if (!res.ok)
            return null;
        return parsePaymentLink(await res.json());
    }
    catch {
        return null;
    }
}
/** Validate the endpoint's body; null unless it carries a usable short link. */
export function parsePaymentLink(body) {
    if (typeof body !== "object" || body === null)
        return null;
    const record = body;
    const { url, plan, monthly_price_usd: price } = record;
    if (typeof url !== "string" || !SHORT_LINK_RE.test(url))
        return null;
    if (typeof plan !== "string" || !PLAN_RE.test(plan))
        return null;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || price > 100_000) {
        return null;
    }
    const expiresAt = typeof record.expires_at === "string" ? Date.parse(record.expires_at) : NaN;
    const reason = record.reason === REASON_FREE_CREDIT_USED || record.reason === REASON_PLAN_LIMIT
        ? record.reason
        : null;
    return { url, plan, monthlyPriceUsd: price, reason,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : null };
}
/** Whether `link` can still be shown or opened (not within the margin of expiring). */
export function paymentLinkFresh(link, now = Date.now()) {
    return link.expiresAt === null || link.expiresAt - now > PAYMENT_LINK_REFRESH_MARGIN_MS;
}
/** "$5", "$7.50": whole dollars without cents. */
export function formatUsd(amount) {
    return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}
/**
 * One process's short link: fetched on demand, reused while fresh, refetched near
 * expiry, and not asked for again for PAYMENT_LINK_RETRY_MS after a failure (so an
 * old server's 404 costs one request, not one per 402).
 */
export class PaymentLinkCache {
    fetchLink;
    now;
    link = null;
    inFlight = null;
    failedAt;
    constructor(fetchLink, now = Date.now) {
        this.fetchLink = fetchLink;
        this.now = now;
    }
    /** The cached link while fresh, else null (never fetches). */
    current() {
        return this.link && paymentLinkFresh(this.link, this.now()) ? this.link : null;
    }
    /** A fresh link: the cached one, or one fetch shared by concurrent callers. */
    get() {
        const cached = this.current();
        if (cached)
            return Promise.resolve(cached);
        if (this.inFlight)
            return this.inFlight;
        if (this.failedAt !== undefined && this.now() - this.failedAt < PAYMENT_LINK_RETRY_MS) {
            return Promise.resolve(null);
        }
        this.inFlight = this.fetchLink().then((link) => {
            this.inFlight = null;
            if (link)
                this.link = link;
            else
                this.failedAt = this.now();
            return link;
        });
        return this.inFlight;
    }
    /** Wait at most `ms` for a fetch already in flight; resolves at once when none is. */
    async settled(ms) {
        if (!this.inFlight)
            return;
        let timer;
        await Promise.race([
            this.inFlight,
            new Promise((resolve) => { timer = setTimeout(resolve, ms); }),
        ]);
        clearTimeout(timer);
    }
}
//# sourceMappingURL=payment-link.js.map