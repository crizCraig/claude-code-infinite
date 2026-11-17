/** Proxy settlement adapter: local totals first; authoritative billing refresh in background. */
import { type SavingsTurnInput } from './savings.js';
import type { DiagnosticsRecorder } from './diagnostics.js';
export interface SavingsTrackerOptions {
    dir?: string;
    usageUrl?: string;
    diagnostics?: DiagnosticsRecorder;
    fetchCosts?: (sessionId: string) => Promise<unknown>;
}
export declare class SavingsTracker {
    private readonly opts;
    private readonly states;
    private readonly epochs;
    private readonly active;
    private readonly inFlight;
    private readonly timers;
    private readonly remote;
    private readonly dir;
    constructor(opts?: SavingsTrackerOptions);
    /** Invalidate the previous billing view before this turn can start new MemTree work. */
    begin(id: string, progress?: number, budget?: number): void;
    settle(id: string, input: SavingsTurnInput): void;
    cancel(id: string): void;
    private endAttempt;
    private get;
    private publish;
    private refresh;
}
//# sourceMappingURL=savings-tracker.d.ts.map