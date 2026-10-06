/** After attempting compression at the soft budget, forward input that fits
 * the model's native context together with its output reservation. */
export function fitsFallbackBudget(
  inputTokens: number,
  outputTokens: number,
  budgetTokens: number,
  contextTokens: number,
): boolean {
  return [inputTokens, outputTokens, budgetTokens, contextTokens].every(
    (value) => Number.isFinite(value) && value >= 0,
  ) && inputTokens + outputTokens <= contextTokens;
}

export interface RouteFallbackError {
  status: 503 | 400;
  attempt: number;
  headers: Record<string, string>;
  body: { type: "error"; error: { type: string; message: string } };
}

/**
 * Claude Code 2.1.288 retries 503 itself, even with SDK maxRetries=0.
 * 529 has extra overload handling (including indefinite watchdog retries).
 * Use ordinary 503 retries and bound the episode in the proxy itself.
 * Successful delivery ends an episode; hook events and elapsed time do not.
 */
export class RouteFallbackFailures {
  private readonly failures = new Map<string, number>();

  constructor(private readonly capacity = 128) {}

  fail(lane: string): RouteFallbackError {
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

  succeeded(lane: string): void {
    this.failures.delete(lane);
  }
}
