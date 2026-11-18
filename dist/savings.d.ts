import type { SavingsReplay } from './savings-history.js';
import type { SavingsUsage } from './savings-report.js';
type SavingsTokens = SavingsUsage;
interface SentPrefix {
    at: number;
    ttl: number;
    exact?: number;
    upper: number;
}
interface SavingsLane {
    model: string;
    full_hash: string;
    removed: number;
    sent: Record<string, SentPrefix>;
}
export interface SavingsState {
    lanes: Record<string, SavingsLane>;
    unknownHistory?: boolean;
}
export interface SavingsTurnInput {
    replay?: SavingsReplay<SavingsPromptCheckpoint>;
    request: unknown;
    usage: unknown;
    model?: string;
    contextWindow: number;
    outputReserve?: number;
    requestModified: boolean;
    originalInputTokens?: number;
    nowMs?: number;
    laneKey?: string;
}
export interface SavingsTurn {
    original_input_tokens: number;
    plain_input_tokens: number;
    input_source: 'actual' | 'counted' | 'estimated';
    compacted: boolean;
    plain_tokens: SavingsTokens;
    actual_tokens?: SavingsTokens;
    fast_mode: boolean;
    window_crossing: boolean;
    floor_read_possibly_uncached_tokens: number | null;
    floor_read_max_gap_seconds: number | null;
}
export declare function isSavingsSessionId(value: unknown): value is string;
export declare const savingsLaneKey: (s: string) => string;
export declare function isSavingsState(value: unknown): value is SavingsState;
/** Cache creation total includes its duration buckets; never count it twice. */
export declare function normalizeSavingsUsage(value: unknown): SavingsTokens | undefined;
export declare function createSavingsState(): SavingsState;
interface SourcePrefix {
    hash: string;
    history: string;
    weight: number;
    ttl: number;
    cacheable: boolean;
}
export interface SavingsPromptCheckpoint {
    model: string;
    frame: string;
    prefixes: SourcePrefix[];
}
/** A settlement can improve the size of an already recorded dispatch. It
 * cannot change who last sent the prefix, its TTL, or the compaction cursor. */
export declare function refineSavingsState(current: SavingsState, settled: SavingsState, dispatched: SavingsState): SavingsState;
export declare function accountSavingsTurn(previous: SavingsState, input: SavingsTurnInput): {
    state: SavingsState;
    turn: SavingsTurn;
};
export {};
//# sourceMappingURL=savings.d.ts.map