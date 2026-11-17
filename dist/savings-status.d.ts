export interface SavingsView {
    net_usd: number | null;
    less_usage_percent: number | null;
    costs_complete: boolean;
    progress_tokens: number;
    budget_tokens: number;
    url?: string;
}
export declare function readSavingsView(id: unknown, dir?: string): SavingsView | undefined;
export declare function writeSavingsView(id: string, view: SavingsView, dir?: string): void;
export declare function visibleWidth(text: string): number;
export declare function renderSavingsSegment(view: SavingsView | undefined, env?: NodeJS.ProcessEnv, width?: number): string;
//# sourceMappingURL=savings-status.d.ts.map