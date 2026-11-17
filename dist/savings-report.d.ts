/** Wire allowlist: content and local cache fingerprints never leave this boundary. */
export interface SavingsReport {
    schema: 1;
    session_id: string;
    sequence: number;
    plain_api_usd: number;
    actual_api_usd: number;
    costs_complete: boolean;
    turns: number;
    window_crossings: number;
    token_counts: Record<string, number>;
}
export declare function savingsReport(value: unknown): SavingsReport | undefined;
//# sourceMappingURL=savings-report.d.ts.map