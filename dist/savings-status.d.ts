export interface SavingsView {
    net_usd: number | null;
    less_usage_percent: number | null;
    costs_complete: boolean;
    progress_tokens: number;
    budget_tokens: number;
    url?: string;
}
/** Query this Claude Code process's ccc launcher (base-URL and HTTPS-proxy modes).
 * The launcher owns the authenticated MemTree client and caches server answers. */
export declare function readSavingsView(id: unknown, env: NodeJS.ProcessEnv, get?: typeof fetch): Promise<SavingsView | undefined>;
export declare function visibleWidth(text: string): number;
export declare function renderSavingsSegment(view: SavingsView | undefined, env?: NodeJS.ProcessEnv, width?: number): string;
//# sourceMappingURL=savings-status.d.ts.map