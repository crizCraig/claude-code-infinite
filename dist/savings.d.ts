export interface SavingsTokens {
    input: number;
    cache_read: number;
    cache_creation_5m: number;
    cache_creation_1h: number;
    output: number;
}
interface Prefix {
    hash: string;
    tokens: number;
    ttl: number;
    at: number;
}
interface Lane {
    prefixes: Prefix[];
    full_hash: string;
    at: number;
    removed: number;
    model: string;
}
export interface SavingsState {
    schema: 1;
    session_id: string;
    sequence: number;
    costs_complete: boolean;
    turns: number;
    window_crossings: number;
    plain_api_usd: number;
    actual_api_usd: number;
    token_counts: SavingsTokens;
    plain_token_counts: SavingsTokens;
    estimated_turns: number;
    progress_tokens?: number;
    budget_tokens?: number;
    lanes: Record<string, Lane>;
}
export interface SavingsTurnInput {
    request: unknown;
    usage: unknown;
    model?: string;
    contextWindow: number;
    outputReserve?: number;
    requestModified: boolean;
    originalInputTokens?: number;
    nowMs?: number;
    laneKey?: string;
    progress_tokens?: number;
    budget_tokens?: number;
}
export interface SavingsTurn {
    original_input_tokens: number;
    plain_input_tokens: number;
    input_source: 'actual' | 'counted' | 'estimated';
    compacted: boolean;
    plain_tokens: SavingsTokens;
    actual_tokens?: SavingsTokens;
    plain_api_usd: number;
    actual_api_usd: number;
    costs_complete: boolean;
}
export interface AuthoritativeSavingsCosts {
    memtree_charged_usd: number;
    compression_api_usd: number;
    costs_complete: boolean;
}
/** Cache creation total includes its duration buckets; never count it twice. */
export declare function normalizeSavingsUsage(value: unknown): SavingsTokens | undefined;
/** Published base input prices, checked 2026-11-17. Unknown generations are unpriced. */
export declare function modelInputPriceUsd(model: string, inputTokens: number): number | undefined;
export declare function createSavingsState(sessionId: string): SavingsState;
/** Pure immutable accounting. The caller settles only successfully forwarded responses once. */
export declare function accountSavingsTurn(previous: SavingsState, input: SavingsTurnInput): {
    state: SavingsState;
    turn: SavingsTurn;
};
export declare function savingsSummary(state: SavingsState, remote?: AuthoritativeSavingsCosts): {
    pure_usd: number | null;
    net_usd: number | null;
    net_percent: number | null;
    less_usage_percent: number | null;
    costs_complete: boolean;
    estimated: boolean;
    plain_api_usd: number;
    actual_api_usd: number;
};
/** Fail closed on corrupt, oversized, redirected, or foreign-session files. */
export declare function loadSavingsState(directory: string, sessionId: string): SavingsState | undefined;
/** One writer per session; callers serialize settlement. Atomic rename protects resumed readers. */
export declare function saveSavingsState(directory: string, state: SavingsState): boolean;
export {};
//# sourceMappingURL=savings.d.ts.map