/** The existing local token estimate is advisory, not an exact tokenizer. */
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