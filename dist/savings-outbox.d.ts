import { type SavingsRecord } from './savings-report.js';
export interface SavingsWriter {
    (value: unknown): void;
    dispatched?(value: unknown): void;
}
type Send = (turns: SavingsRecord[]) => Promise<Response>;
export declare class SavingsOutbox {
    private readonly send;
    private readonly now;
    private readonly directory;
    readonly cacheDirectory: string;
    private readonly writes;
    private drain?;
    private appendedDuringDrain;
    private suspended;
    constructor(configDir: string, baseUrl: string, key: string, send: Send, now: () => number);
    get enabled(): boolean;
    suspend(): void;
    /** Bind both phases to this account, including turns settled after a re-key. */
    writer(): SavingsWriter;
    append(value: unknown, inFlight?: string): void;
    private publish;
    flush(): Promise<void>;
    private drainPending;
    private sendPending;
    private sendBatch;
}
export {};
//# sourceMappingURL=savings-outbox.d.ts.map