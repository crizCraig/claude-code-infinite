import type { SavingsUsage } from './savings-report.js';
interface DurationRange {
    ttl: number;
    end: number | null;
}
interface SavingsLane {
    sequence: number;
    messages: number;
    at: number;
    minRemoved: number;
    maxRemoved: number;
    writer?: string;
    total: number | null;
    durations: DurationRange[];
}
export interface SavingsState {
    lanes: Record<string, SavingsLane>;
    unknownHistory?: boolean;
    evicted?: boolean;
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
    prefixCount?: {
        messages: number;
        tokens: number;
    };
    interruptedStream?: boolean;
    possiblyResumed?: boolean;
    writer?: string;
}
export interface SavingsTurn {
    original_input_tokens: number | null;
    plain_input_tokens: number | null;
    input_source: 'actual' | 'counted' | 'unmeasured';
    compacted: boolean;
    prefix_messages_to_count?: number;
    plain_tokens: SavingsUsage | null;
    actual_tokens?: SavingsUsage;
    fast_mode: boolean;
    window_crossing: boolean;
    floor_read_possibly_uncached_tokens: number | null;
    floor_read_max_gap_seconds: number | null;
}
export declare function isSavingsSessionId(value: unknown): value is string;
export declare const savingsLaneKey: (s: string) => string;
export declare function isSavingsState(value: unknown): value is SavingsState;
/** Cache creation total includes its duration buckets; never count it twice. */
export declare function normalizeSavingsUsage(value: unknown): SavingsUsage | undefined;
export declare function createSavingsState(): SavingsState;
export declare function savingsRetainedRequest(request: Record<string, any>, retained: number): {
    messages: any;
};
export declare function refineSavingsState(current: SavingsState, settled: SavingsState, dispatched: SavingsState): SavingsState;
export declare function accountSavingsTurn(previous: SavingsState, input: SavingsTurnInput): {
    state: SavingsState;
    turn: SavingsTurn;
};
export {};
//# sourceMappingURL=savings.d.ts.map