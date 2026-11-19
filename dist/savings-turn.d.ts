import type { SavingsWriter } from './savings-outbox.js';
import { type SavingsTurnInput } from './savings.js';
export type DispatchInput = Omit<SavingsTurnInput, 'usage'> & {
    possiblyResumed?: boolean;
};
export type CountSavingsPrefix = (messages: number) => Promise<number | undefined>;
export interface SavingsReply {
    report?: unknown;
    countMessages?: number;
}
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
    canCount?: boolean;
    prefixCount?: {
        messages: number;
        tokens: number;
    };
    interruptedStream?: boolean;
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
    constructor(sessionId: string, report: SavingsWriter, scope: string, cacheDirectory?: string | undefined);
    /** Publish an empty, private reservation before sending. Another launcher's
     * worker can now see this dispatch even if our own worker is backlogged. */
    announce(laneKey: string): Promise<void>;
    dispatched(input: DispatchInput): void;
    settle(input: SavingsTurnInput, status: number, countPrefix?: CountSavingsPrefix): Promise<void>;
    private incomplete;
}
//# sourceMappingURL=savings-turn.d.ts.map