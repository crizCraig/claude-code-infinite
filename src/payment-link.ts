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
export const PAYMENT_LINK_TIMEOUT_MS = 1500;

export const REASON_FREE_CREDIT_USED = "free_credit_used";
export const REASON_PLAN_LIMIT = "plan_limit";

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

// The link must be our short path on one of our hosts: a hostile or broken body
// can't put an arbitrary URL (or terminal controls) on screen or into `open`.
const SHORT_LINK_RE = new RegExp(
  "^(?:https:\\/\\/(?:[a-z0-9-]+\\.)*(?:polychat\\.co|run\\.app)" +
  "|http:\\/\\/(?:local\\.polychat\\.co|localhost|127\\.0\\.0\\.1)(?::\\d+)?)" +
  "\\/p\\/[A-Za-z0-9]{12,64}$"
);
const PLAN_RE = /^[A-Za-z0-9 %.+-]{1,40}$/;

/** Ask the server for a short link; null on any failure. Never throws. */
export async function fetchPaymentLink(opts: PaymentLinkFetchOptions): Promise<PaymentLink | null> {
  try {
    const res = await (opts.fetchImpl ?? fetch)(
      `${opts.baseUrl.replace(/\/$/, "")}${PAYMENT_LINK_PATH}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, ...opts.headers },
        signal: AbortSignal.timeout(opts.timeoutMs ?? PAYMENT_LINK_TIMEOUT_MS),
      }
    );
    if (!res.ok) return null;
    return parsePaymentLink(await res.json());
  } catch {
    return null;
  }
}

/** Validate the endpoint's body; null unless it carries a usable short link. */
export function parsePaymentLink(body: unknown): PaymentLink | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const { url, plan, monthly_price_usd: price } = record;
  if (typeof url !== "string" || !SHORT_LINK_RE.test(url)) return null;
  if (typeof plan !== "string" || !PLAN_RE.test(plan)) return null;
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
export function paymentLinkFresh(link: PaymentLink, now = Date.now()): boolean {
  return link.expiresAt === null || link.expiresAt - now > PAYMENT_LINK_REFRESH_MARGIN_MS;
}

/** "$5", "$7.50": whole dollars without cents. */
export function formatUsd(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/**
 * One process's short link: fetched on demand, reused while fresh, refetched near
 * expiry, and not asked for again for PAYMENT_LINK_RETRY_MS after a failure (so an
 * old server's 404 costs one request, not one per 402).
 */
export class PaymentLinkCache {
  private link: PaymentLink | null = null;
  private inFlight: Promise<PaymentLink | null> | null = null;
  private failedAt: number | undefined;

  constructor(
    private readonly fetchLink: () => Promise<PaymentLink | null>,
    private readonly now: () => number = Date.now
  ) {}

  /** The cached link while fresh, else null (never fetches). */
  current(): PaymentLink | null {
    return this.link && paymentLinkFresh(this.link, this.now()) ? this.link : null;
  }

  /** A fresh link: the cached one, or one fetch shared by concurrent callers. */
  get(): Promise<PaymentLink | null> {
    const cached = this.current();
    if (cached) return Promise.resolve(cached);
    if (this.inFlight) return this.inFlight;
    if (this.failedAt !== undefined && this.now() - this.failedAt < PAYMENT_LINK_RETRY_MS) {
      return Promise.resolve(null);
    }
    this.inFlight = this.fetchLink().catch(() => null).then((link) => {
      this.inFlight = null;
      if (link) this.link = link;
      else this.failedAt = this.now();
      return link;
    });
    return this.inFlight;
  }

  /** Wait at most `ms` for a fetch already in flight; resolves at once when none is. */
  async settled(ms: number): Promise<void> {
    if (!this.inFlight) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.inFlight,
      new Promise((resolve) => { timer = setTimeout(resolve, ms); timer.unref(); }),
    ]);
    clearTimeout(timer);
  }
}
