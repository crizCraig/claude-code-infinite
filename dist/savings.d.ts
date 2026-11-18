import type { SavingsReplay } from './savings-history.js';
import type { SavingsUsage } from './savings-report.js';
type SavingsTokens = SavingsUsage;
interface SavedPrefix {
    hash: string;
    tokens: number;
}
export interface SavingsLane {
    at: number;
    model: string;
    full_hash: string;
    removed: number;
    hourEnd: number;
    cacheEnd: number;
    prefixes: SavedPrefix[];
}
export interface SavingsState {
    lanes: Record<string, SavingsLane>;
}
export interface SavingsTurnInput {
    /** A new compression/preparation/truncation, as opposed to riding an existing prefix. */
    prefixRewritten: boolean;
    forwardedRequest?: unknown;
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
}
export declare function isSavingsSessionId(value: unknown): value is string;
export declare const savingsLaneKey: (s: string) => string;
/** Old simulated checkpoints cannot establish measured coverage. */
export declare function isSavingsLane(value: unknown, at: number): value is SavingsLane;
/** Cache creation total includes its duration buckets; never count it twice. */
export declare function normalizeSavingsUsage(value: unknown): SavingsTokens | undefined;
export declare function createSavingsState(): SavingsState;
interface SourcePrefix {
    hash: string;
    content: string;
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
/** Account one successfully forwarded response. The optional local replay cache holds prefix work. */
export declare function accountSavingsTurn(previous: SavingsState, input: SavingsTurnInput): {
    state: SavingsState;
    turn: SavingsTurn;
};
export {};
//# sourceMappingURL=savings.d.ts.map