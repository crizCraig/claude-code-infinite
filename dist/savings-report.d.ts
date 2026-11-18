export interface SavingsUsage {
    input: number;
    cache_read: number;
    cache_creation_5m: number;
    cache_creation_1h: number;
    output: number;
}
export interface SavingsRecord {
    turn_id: string;
    session_id: string;
    requested_at: string;
    model: string;
    fast_mode: boolean;
    expected_memtree_calls?: number;
    window_crossing: boolean;
    actual: SavingsUsage | null;
    plain: SavingsUsage | null;
}
export declare function savingsReport(value: unknown): SavingsRecord | undefined;
//# sourceMappingURL=savings-report.d.ts.map