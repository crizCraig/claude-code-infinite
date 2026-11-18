import type { SavingsTurnInput } from './savings.js';
type WorkerInput = Omit<SavingsTurnInput, 'replay'>;
export type SavingsJob = {
    kind: 'dispatch';
    id: string;
    sessionId: string;
    cacheDirectory: string;
    laneKey: string;
    at: number;
    order: bigint;
} | {
    kind: 'settle';
    id: string;
    sessionId: string;
    scope: string;
    input: WorkerInput;
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
    constructor(sessionId: string, report: (value: unknown) => void, scope: string, cacheDirectory?: string | undefined);
    dispatched(laneKey: string, at: number): void;
    settle(input: WorkerInput, status: number): Promise<void>;
}
export {};
//# sourceMappingURL=savings-turn.d.ts.map