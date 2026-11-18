import { SavingsObservation } from './savings-turn.js';
import type { Diagnostics } from './diagnostics.js';
import { SavingsHistory } from './savings-history.js';
import type { SavingsView } from './savings-status.js';
import { type SavingsPromptCheckpoint, type SavingsTurnInput } from './savings.js';
interface SavingsTrackerOptions {
    usageUrl?: string;
    diagnostics?: Pick<Diagnostics, 'savingsAccount' | 'bindSavings' | 'savingsCacheDirectory'>;
    fetchTotal?: (sessionId: string) => Promise<unknown>;
    now?: () => number;
}
export declare class SavingsTracker {
    private readonly opts;
    readonly history: SavingsHistory<SavingsPromptCheckpoint>;
    private readonly sessions;
    private readonly account?;
    constructor(opts?: SavingsTrackerOptions);
    /** Only a main conversation request updates the launcher's budget indicator. */
    progress(id: unknown, tokens: number, budget: number): void;
    startTurn(id: unknown): SavingsObservation | undefined;
    /** Only upstream dispatches contribute an API turn. Billing records MemTree independently. */
    settle(observation: SavingsObservation, input: SavingsTurnInput, status: number): void;
    /** Called only by the status line. One fetch per session per ten seconds, including failures. */
    view(id: unknown): Promise<SavingsView | undefined>;
    private refresh;
    private session;
}
export {};
//# sourceMappingURL=savings-tracker.d.ts.map