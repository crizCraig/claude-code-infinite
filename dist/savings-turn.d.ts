import { type SavingsTurnInput } from './savings.js';
type WorkerInput = Omit<SavingsTurnInput, 'replay'>;
export type DispatchInput = Omit<WorkerInput, 'usage'> & {
    possiblyResumed?: boolean;
};
export type SavingsJob = {
    kind: 'dispatch';
    id: string;
    sessionId: string;
    scope: string;
    cacheDirectory?: string;
    writer: string;
    reservation?: string;
    announcementFailed: boolean;
    input: DispatchInput;
} | {
    kind: 'settle';
    id: string;
    usage: unknown;
    status: number;
};
export declare class SavingsObservation {
    readonly sessionId: string;
    private readonly report;
    private readonly scope;
    private readonly cacheDirectory?;
    readonly id: `${string}-${string}-${string}-${string}-${string}`;
    requestedAt?: number;
    private closed;
    private reservation?;
    private announcementFailed;
    constructor(sessionId: string, report: (value: unknown) => void, scope: string, cacheDirectory?: string | undefined);
    /** Publish an empty, private reservation before sending. Another launcher's
     * worker can now see this dispatch even if our own worker is backlogged. */
    announce(laneKey: string): Promise<void>;
    dispatched(input: DispatchInput): void;
    settle(input: WorkerInput, status: number): Promise<void>;
}
export {};
//# sourceMappingURL=savings-turn.d.ts.map