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
import { type PaymentLink } from "./payment-link.js";
export declare const FALLBACK_SUBSCRIBE_URL = "https://polychat.co/pricing";
/** Query flag on the checkout link so the server's success page says "go back to your terminal". */
export declare const CHECKOUT_SOURCE_PARAM = "source=ccc";
export declare const PAUSED_FREE_CREDIT_HEADLINE = "MemTree is paused: your free credit is used up.";
export declare const PAUSED_PLAN_LIMIT_HEADLINE = "MemTree is paused: your plan's usage limit is reached.";
export declare const PAUSED_HEADLINE = "MemTree is paused: payment required.";
/**
 * What a paused session runs without. With [c] ccc starts plain Claude Code
 * (cli-main.ts), whose own auto-compaction summarizes a long session, and nothing
 * reaches MemTree, so the session is not indexed, saved there, or searchable.
 */
export declare const PAUSED_LOSS_LINES: string;
/** After [c]: the session runs as plain Claude Code; the next start checks again. */
export declare const MEMTREE_OFF_LINE = "MemTree is off for this session. ccc checks again the next time you start it.";
/** Print/non-TTY runs of an unpaid key: one stderr line, then plain Claude Code. */
export declare const RESUMED_PAUSED_LINE = "MemTree is paused, so this resumed session runs uncompressed. ccc checks again next start.";
export declare const PRINT_PAUSED_LINE: string;
export type PaymentStatus = {
    paid: boolean;
    /** Plain-text prompt from the server, or null when paid. */
    message: string | null;
    /** Subscribe link: the server's payment_url, else the first /payment?… link in the message. */
    url: string | null;
};
export type PaymentChoice = "subscribe" | "continue" | "quit";
/**
 * Parse a status body. Returns null when the body does not carry a boolean
 * `paid` (old server, wrong shape): the caller treats that as "unknown" and
 * stays quiet, exactly like a network error.
 */
export declare function parsePaymentStatus(body: unknown): PaymentStatus | null;
/** Append `source=ccc` to a `/payment?…` link (idempotent); a short link already implies it. */
export declare function withCheckoutSource(url: string): string;
/** The short checkout link in a payment prompt, else its first `/payment?…` link, else null. */
export declare function extractPaymentUrl(message: string | null): string | null;
/**
 * A 402 detail with its `/payment?…` link replaced by the short one, so every
 * in-session notice built from it shows the short link. Unchanged without either.
 */
export declare function withShortPaymentUrl(detail: string, shortUrl: string | null | undefined): string;
/**
 * The gate's text, at most four lines above the prompt: why MemTree is paused,
 * what the session loses without it, and the plan, price and link. The full
 * server message is deliberately not echoed: it is several paragraphs written
 * for a chat window, and the prompt below is the point.
 */
export declare function formatPaymentNotice(status: PaymentStatus, options?: {
    hyperlinks?: boolean;
    color?: boolean;
    link?: PaymentLink | null;
}): string;
/** The prompt line, with the server's price when it gave one. */
export declare function paymentGatePrompt(link?: PaymentLink | null): string;
/** The first line: why MemTree is paused, as far as the server said. */
export declare function pausedHeadline(reason: string | null): string;
/** OSC 8 terminal hyperlink: `text` shown, `url` opened on click. */
export declare function hyperlink(text: string, url: string): string;
/** "Starter plan, $5/month" from the recommender's prose, or null. */
export declare function extractRecommendedPlan(message: string | null): string | null;
/** Map a prompt answer to a choice. Enter (empty) or `s` subscribes. */
export declare function parsePaymentChoice(answer: string): PaymentChoice;
//# sourceMappingURL=payment-gate.d.ts.map