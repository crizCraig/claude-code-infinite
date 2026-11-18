import type { SavingsReplay } from './savings-history.js';
import type { SavingsUsage } from './savings-report.js';
type SavingsTokens = SavingsUsage;
interface Prefix {
    hash: string;
    tokens: number;
    ttl: number;
    at: number;
}
export interface SavingsLane {
    prefixes: Prefix[];
    full_hash: string;
    at: number;
    removed: number;
    model: string;
    warm?: {
        five: number;
        hour: number;
        at: number;
    };
}
export interface SavingsState {
    lanes: Record<string, SavingsLane>;
}
type LaneKind = 'main' | 'agent' | 'away';
export interface SavingsTurnInput {
    laneKind?: LaneKind;
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
    previousAt?: number;
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
/** Reject partial or obsolete checkpoints without discarding their known dispatch time. */
export declare function isSavingsLane(value: unknown, at: number): value is SavingsLane;
/** Cache creation total includes its duration buckets; never count it twice. */
export declare function normalizeSavingsUsage(value: unknown): SavingsTokens | undefined;
export declare function createSavingsState(): SavingsState;
interface SourcePrefix {
    hash: string;
    history: string;
    weight: number;
    position: number;
    index: number;
    ttl: number;
    toolRun?: string;
    cacheable: boolean;
    messageIndex: number;
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