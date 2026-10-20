/**
 * Startup payment gate for interactive `ccc` sessions.
 *
 * GET /v1/context_memory/status says whether the MemTree key is paid up. When
 * it is not, an interactive session stops on a short prompt before Claude Code
 * takes the terminal (the TUI would cover a printed warning within a second):
 *
 *   MemTree is paused: your free credit is used up.
 *   Without it, long sessions hit the context limit and get compacted, losing information,
 *   and your sessions aren't saved or searchable.
 *   Starter is $5/month: https://app.polychat.co/p/Ab3xY9…
 *   [Enter] subscribe ($5/mo)   [c] continue without MemTree   [q] quit:
 *
 * The plan, price, reason and short link come from POST /v1/payment/link
 * (payment-link.ts); an older server without it gets the status probe's
 * `/payment?…` link and the plan named in its prose.
 *
 * Everything that needs no terminal lives here so it can be unit-tested:
 * parsing the status body, formatting the notice, and mapping keystrokes to a
 * choice. The prompt loop itself is in cli-main.ts.
 */

import {
  type PaymentLink,
  REASON_FREE_CREDIT_USED,
  REASON_PLAN_LIMIT,
  formatUsd,
} from "./payment-link.js";

export const FALLBACK_SUBSCRIBE_URL = "https://polychat.co/pricing";

/** Query flag on the checkout link so the server's success page says "go back to your terminal". */
export const CHECKOUT_SOURCE_PARAM = "source=ccc";

export const PAUSED_FREE_CREDIT_HEADLINE = "MemTree is paused: your free credit is used up.";
export const PAUSED_PLAN_LIMIT_HEADLINE = "MemTree is paused: your plan's usage limit is reached.";
export const PAUSED_HEADLINE = "MemTree is paused: payment required.";
/**
 * What a paused session runs without. With [c] ccc starts plain Claude Code
 * (cli-main.ts), whose own auto-compaction summarizes a long session, and nothing
 * reaches MemTree, so the session is not indexed, saved there, or searchable.
 */
export const PAUSED_LOSS_LINES =
  "Without it, long sessions hit the context limit and get compacted, losing\n" +
  "information, and your sessions aren't saved or searchable.";
/** After [c]: the session runs as plain Claude Code; the next start checks again. */
export const MEMTREE_OFF_LINE =
  "MemTree is off for this session. ccc checks again the next time you start it.";
/** Print/non-TTY runs of an unpaid key: one stderr line, then plain Claude Code. */
export const PRINT_PAUSED_LINE =
  "ccc: MemTree is paused (payment required), so this run is plain Claude Code. " +
  "Run ccc in a terminal to subscribe.";

export type PaymentStatus = {
  paid: boolean;
  /** Plain-text prompt from the server, or null when paid. */
  message: string | null;
  /** Subscribe link: the server's payment_url, else the first /payment?… link in the message. */
  url: string | null;
};

export type PaymentChoice = "subscribe" | "continue" | "quit";

const PAYMENT_URL_RE = /https?:\/\/\S+\/payment\?\S+/;
/** The short checkout link (payment-link.ts) that ccc puts in place of the `/payment?…` one. */
const SHORT_PAYMENT_URL_RE = /https?:\/\/[^\s/]+\/p\/[A-Za-z0-9]{12,64}(?![A-Za-z0-9])/;
// "we recommend 🌱 Starter plan for $5/month" → plan name + price.
const RECOMMENDED_PLAN_RE = /recommend\s+(?:\S+\s+)?([A-Za-z][\w ]*?plan)\s+for\s+(\$[\d.]+\/month)/i;
const SAFE_URL_RE = /^https?:\/\/[^\s"'`$<>\\\u0000-\u001f\u007f-\u009f]+$/;
// C0 controls, DEL, and C1 controls.
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Parse a status body. Returns null when the body does not carry a boolean
 * `paid` (old server, wrong shape): the caller treats that as "unknown" and
 * stays quiet, exactly like a network error.
 */
export function parsePaymentStatus(body: unknown): PaymentStatus | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.paid !== "boolean") return null;
  const message =
    typeof record.payment_message === "string" && record.payment_message.trim()
      ? record.payment_message
      : null;
  const explicitUrl =
    typeof record.payment_url === "string" && record.payment_url.trim()
      ? record.payment_url.trim()
      : null;
  const found = explicitUrl ?? extractPaymentUrl(message);
  // Printed and handed to the browser opener: a plain http(s) URL only.
  const url = found && SAFE_URL_RE.test(found) ? found : null;
  return {
    paid: record.paid,
    message,
    url: url ? withCheckoutSource(url) : null,
  };
}

/** Append `source=ccc` to a `/payment?…` link (idempotent); a short link already implies it. */
export function withCheckoutSource(url: string): string {
  if (url.includes(CHECKOUT_SOURCE_PARAM) || SHORT_PAYMENT_URL_RE.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${CHECKOUT_SOURCE_PARAM}`;
}

/** The short checkout link in a payment prompt, else its first `/payment?…` link, else null. */
export function extractPaymentUrl(message: string | null): string | null {
  if (!message) return null;
  const match = SHORT_PAYMENT_URL_RE.exec(message) ?? PAYMENT_URL_RE.exec(message);
  return match ? match[0] : null;
}

/**
 * A 402 detail with its `/payment?…` link replaced by the short one, so every
 * in-session notice built from it shows the short link. Unchanged without either.
 */
export function withShortPaymentUrl(detail: string, shortUrl: string | null | undefined): string {
  if (!shortUrl) return detail;
  return detail.replace(new RegExp(PAYMENT_URL_RE.source, "g"), () => shortUrl);
}

/**
 * The gate's text, at most four lines above the prompt: why MemTree is paused,
 * what the session loses without it, and the plan, price and link. The full
 * server message is deliberately not echoed: it is several paragraphs written
 * for a chat window, and the prompt below is the point.
 */
export function formatPaymentNotice(
  status: PaymentStatus,
  options: { hyperlinks?: boolean; color?: boolean; link?: PaymentLink | null } = {}
): string {
  const link = options.link ?? null;
  const headline = pausedHeadline(link?.reason ?? null);
  const url = link?.url ?? status.url ?? FALLBACK_SUBSCRIBE_URL;
  const shownUrl = options.hyperlinks ? hyperlink(url, url) : url;
  return [
    options.color ? `\x1b[1;33m${headline}\x1b[0m` : headline,
    PAUSED_LOSS_LINES,
    `${offerLabel(status, link)}: ${shownUrl}`,
  ].join("\n");
}

/** The prompt line, with the server's price when it gave one. */
export function paymentGatePrompt(link: PaymentLink | null = null): string {
  const verb = link?.reason === REASON_PLAN_LIMIT ? "upgrade" : "subscribe";
  const price = link ? ` (${formatUsd(link.monthlyPriceUsd)}/mo)` : "";
  return `[Enter] ${verb}${price}   [c] continue without MemTree   [q] quit: `;
}

/** The first line: why MemTree is paused, as far as the server said. */
export function pausedHeadline(reason: string | null): string {
  if (reason === REASON_FREE_CREDIT_USED) return PAUSED_FREE_CREDIT_HEADLINE;
  if (reason === REASON_PLAN_LIMIT) return PAUSED_PLAN_LIMIT_HEADLINE;
  return PAUSED_HEADLINE;
}

/** "Starter is $5/month", else the old server's "Starter plan, $5/month", else "Subscribe". */
function offerLabel(status: PaymentStatus, link: PaymentLink | null): string {
  if (link) return `${link.plan} is ${formatUsd(link.monthlyPriceUsd)}/month`;
  return extractRecommendedPlan(status.message) ?? "Subscribe";
}

/** OSC 8 terminal hyperlink: `text` shown, `url` opened on click. */
export function hyperlink(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** "Starter plan, $5/month" from the recommender's prose, or null. */
export function extractRecommendedPlan(message: string | null): string | null {
  if (!message) return null;
  const match = RECOMMENDED_PLAN_RE.exec(message.replace(CONTROL_CHARS_RE, " "));
  return match ? `${match[1].trim()}, ${match[2]}` : null;
}

/** Map a prompt answer to a choice. Enter (empty) or `s` subscribes. */
export function parsePaymentChoice(answer: string): PaymentChoice {
  const key = answer.trim().toLowerCase();
  if (key === "" || key === "s" || key === "subscribe") return "subscribe";
  if (key === "q" || key === "quit" || key === "exit") return "quit";
  return "continue";
}

