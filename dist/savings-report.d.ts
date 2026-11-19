export interface SavingsUsage {
    input: number;
    cache_read: number;
    cache_creation_5m: number;
    cache_creation_1h: number;
    output: number;
}
interface SavingsIdentity {
    turn_id: string;
    session_id: string;
    requested_at: string;
}
declare const incompleteReasons: readonly ["interrupted_dispatch", "interrupted_stream", "unmeasured_input", "missing_usage"];
type IncompleteReason = typeof incompleteReasons[number];
type LegacyPreflight = SavingsIdentity & {
    outcome: 'not_dispatched';
    expected_memtree_calls: number;
};
export type SavingsRecord = LegacyPreflight | (SavingsIdentity & {
    model: string;
    incomplete_reason?: IncompleteReason;
    fast_mode: boolean;
    window_crossing: boolean;
    floor_read_possibly_uncached_tokens?: number | null;
    floor_read_max_gap_seconds?: number | null;
    actual: SavingsUsage | null;
    plain: SavingsUsage | null;
});
export declare function savingsReport(value: unknown): SavingsRecord | undefined;
export {};
//# sourceMappingURL=savings-report.d.ts.map