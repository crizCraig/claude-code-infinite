import { type SavingsReport } from './savings-report.js';
export interface LegacyRetry {
    since: number;
    next: number;
    attempts: number;
}
export interface PendingSavings {
    report: SavingsReport;
    retry?: LegacyRetry;
}
export declare class SavingsOutbox {
    private readonly directory;
    constructor(configDir: string, baseUrl: string, apiKey: string);
    restore(): Map<string, PendingSavings>;
    private readRetry;
    saveRetry(report: SavingsReport, retry: LegacyRetry): void;
    clearRetry(report: SavingsReport): void;
    save(report: SavingsReport): boolean;
    private write;
    remove(report: SavingsReport): void;
    private file;
}
//# sourceMappingURL=savings-outbox.d.ts.map