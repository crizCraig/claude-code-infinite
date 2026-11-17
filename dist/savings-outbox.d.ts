import { type SavingsReport } from './savings-report.js';
export declare class SavingsOutbox {
    private readonly directory;
    constructor(configDir: string, baseUrl: string, apiKey: string);
    restore(): Map<string, SavingsReport>;
    save(report: SavingsReport): boolean;
    remove(report: SavingsReport): void;
    private file;
}
//# sourceMappingURL=savings-outbox.d.ts.map