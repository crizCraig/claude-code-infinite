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
export declare const FALLBACK_SUBSCRIBE_URL = "https://polychat.co/pricing";
export declare const PAYMENT_GATE_HEADLINE = "\u26A0 MemTree is off \u2014 payment required (compression + indexing disabled).";
export declare const PAYMENT_GATE_PROMPT = "[Enter] subscribe now   [c] use claude without MemTree   [q] quit: ";
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
/** First `/payment?…` link in a payment prompt, or null. */
export declare function extractPaymentUrl(message: string | null): string | null;
/**
 * Terminal text for an unpaid key: the headline and one line with the
 * recommended plan (when the server's prose names one) and the subscribe
 * link. The full server message is deliberately not echoed — it is several
 * paragraphs written for a chat window, and the prompt below is the point.
 */
export declare function formatPaymentNotice(status: PaymentStatus, options?: {
    hyperlinks?: boolean;
}): string;
/** OSC 8 terminal hyperlink: `text` shown, `url` opened on click. */
export declare function hyperlink(text: string, url: string): string;
/** "Starter plan, $5/month" from the recommender's prose, or null. */
export declare function extractRecommendedPlan(message: string | null): string | null;
/** Map a prompt answer to a choice. Enter (empty) or `s` subscribes. */
export declare function parsePaymentChoice(answer: string): PaymentChoice;
//# sourceMappingURL=payment-gate.d.ts.map