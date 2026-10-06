/**
 * Whether the original request may go out unchanged when no compressed form is
 * available: its input is within the compaction budget (an over-budget input
 * that could not be compressed is refused, so a session never grows whole
 * toward the window and strands), and input plus the output reservation fits
 * the context window.
 *
 * The budget is compared with the input alone, as the server compares it: the
 * server does not compress a request whose input is under its budget, so
 * counting the output reservation here too left every request between
 * budget - max_tokens and the budget with no way out (2026-10-03 benchmark:
 * 777k input + 128k output against 800k, on a 1M window, failed outright, with
 * compaction off as well). The local token estimate is advisory.
 */
export declare function fitsFallbackBudget(inputTokens: number, outputTokens: number, budgetTokens: number, contextTokens: number): boolean;
export interface RouteFallbackError {
    status: 503 | 400;
    attempt: number;
    headers: Record<string, string>;
    body: {
        type: "error";
        error: {
            type: string;
            message: string;
        };
    };
}
/**
 * Claude Code 2.1.288 retries 503 itself, even with SDK maxRetries=0.
 * 529 has extra overload handling (including indefinite watchdog retries).
 * Use ordinary 503 retries and bound the episode in the proxy itself.
 * Successful delivery ends an episode; hook events and elapsed time do not.
 */
export declare class RouteFallbackFailures {
    private readonly capacity;
    private readonly failures;
    constructor(capacity?: number);
    fail(lane: string): RouteFallbackError;
    succeeded(lane: string): void;
}
//# sourceMappingURL=route-fallback.d.ts.map