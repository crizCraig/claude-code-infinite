/** The existing local token estimate is advisory, not an exact tokenizer. */
export function fitsFallbackBudget(inputTokens, outputTokens, budgetTokens, contextTokens) {
    return [inputTokens, outputTokens, budgetTokens, contextTokens].every((value) => Number.isFinite(value) && value >= 0) && inputTokens + outputTokens <= Math.min(budgetTokens, contextTokens);
}
/**
 * Claude Code 2.1.288 retries 503 itself, even with SDK maxRetries=0.
 * 529 has extra overload handling (including indefinite watchdog retries).
 * Use ordinary 503 retries and bound the episode in the proxy itself.
 * Successful delivery ends an episode; hook events and elapsed time do not.
 */
export class RouteFallbackFailures {
    capacity;
    failures = new Map();
    constructor(capacity = 128) {
        this.capacity = capacity;
    }
    fail(lane) {
        const previous = this.failures.get(lane);
        // Fail closed when full rather than evicting a lane and granting it
        // another retry budget. A successful lane frees its slot.
        const attempt = previous === undefined && this.failures.size >= this.capacity
            ? 3 : Math.min((previous ?? 0) + 1, 3);
        if (previous !== undefined || this.failures.size < this.capacity) {
            this.failures.set(lane, attempt);
        }
        const retry = attempt <= 2;
        return {
            status: retry ? 503 : 400,
            attempt,
            headers: retry
                ? { "retry-after": "1", "x-should-retry": "true" }
                : { "x-should-retry": "false" },
            body: {
                type: "error",
                error: {
                    type: retry ? "api_error" : "invalid_request_error",
                    message: retry
                        ? "MemTree could not produce a usable compressed request; retrying within a bounded limit."
                        : "MemTree could not fit this request within its budget. Automatic recovery stopped; retry after service recovery or reduce the conversation.",
                },
            },
        };
    }
    succeeded(lane) {
        this.failures.delete(lane);
    }
}
//# sourceMappingURL=route-fallback.js.map