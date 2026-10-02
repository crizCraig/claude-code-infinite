/**
 * Startup payment gate for interactive `ccc` sessions.
 *
 * GET /v1/context_memory/status says whether the MemTree key is paid up. When
 * it is not, the launcher used to print a warning and start claude anyway —
 * but the TUI covers the terminal within a second, so the warning was never
 * read. Instead, an unpaid interactive session now stops on a prompt:
 *
 *   [Enter] subscribe now   [c] use claude without MemTree   [q] quit
 *
 * Everything that needs no terminal lives here so it can be unit-tested:
 * parsing the status body, formatting the notice, and mapping keystrokes to a
 * choice. The prompt loop itself is in cli.ts.
 */

export const FALLBACK_SUBSCRIBE_URL = "https://polychat.co/pricing";

/** Query flag on the checkout link so the server's success page says "go back to your terminal". */
export const CHECKOUT_SOURCE_PARAM = "source=ccc";

export const PAYMENT_GATE_HEADLINE =
  "⚠ MemTree is off — payment required (compression + indexing disabled).";

export const PAYMENT_GATE_PROMPT =
  "[Enter] subscribe now   [c] use claude without MemTree   [q] quit: ";

export type PaymentStatus = {
  paid: boolean;
  /** Plain-text prompt from the server, or null when paid. */
  message: string | null;
  /** Subscribe link: the server's payment_url, else the first /payment?… link in the message. */
  url: string | null;
};

export type PaymentChoice = "subscribe" | "continue" | "quit";

const PAYMENT_URL_RE = /https?:\/\/\S+\/payment\?\S+/;
// "we recommend 🌱 Starter plan for $5/month" → plan name + price.
const RECOMMENDED_PLAN_RE = /recommend\s+(?:\S+\s+)?([A-Za-z][\w ]*?plan)\s+for\s+(\$[\d.]+\/month)/i;
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
  const url = explicitUrl ?? extractPaymentUrl(message);
  return {
    paid: record.paid,
    message,
    url: url ? withCheckoutSource(url) : null,
  };
}

/** Append `source=ccc` to a checkout link (idempotent). */
export function withCheckoutSource(url: string): string {
  if (url.includes(CHECKOUT_SOURCE_PARAM)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${CHECKOUT_SOURCE_PARAM}`;
}

/** First `/payment?…` link in a payment prompt, or null. */
export function extractPaymentUrl(message: string | null): string | null {
  if (!message) return null;
  const match = PAYMENT_URL_RE.exec(message);
  return match ? match[0] : null;
}

/**
 * Terminal text for an unpaid key: the headline and one line with the
 * recommended plan (when the server's prose names one) and the subscribe
 * link. The full server message is deliberately not echoed — it is several
 * paragraphs written for a chat window, and the prompt below is the point.
 */
export function formatPaymentNotice(
  status: PaymentStatus,
  options: { hyperlinks?: boolean } = {}
): string {
  const plan = extractRecommendedPlan(status.message);
  const url = status.url ?? FALLBACK_SUBSCRIBE_URL;
  if (!options.hyperlinks) return `${PAYMENT_GATE_HEADLINE}\n  ${plan ? `${plan}: ` : ""}${url}`;
  // Interactive terminals: the plan name is an OSC 8 link to checkout, and the
  // URL is printed below it for terminals without hyperlinks (and to copy).
  return `${PAYMENT_GATE_HEADLINE}\n  ${hyperlink(plan ?? "Subscribe", url)}\n  ${url}`;
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

