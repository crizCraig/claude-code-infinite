/** A context_memory POST can start before, during or after its source turn. */
export declare class SavingsObservation {
    readonly sessionId: string;
    readonly enabled: () => boolean;
    readonly report: (value: unknown) => void;
    readonly id: `${string}-${string}-${string}-${string}-${string}`;
    calls: number;
    closed: boolean;
    constructor(sessionId: string, enabled: () => boolean, report: (value: unknown) => void);
    work(metadata: Record<string, string>): Record<string, string>;
}
/** Count submitted calls until the server definitively refuses them before billable work.
 * A lost response after upload is ambiguous, so its charge remains expected. */
export declare function beginSavingsSubmission(metadata?: Record<string, string>): {
    metadata: {
        savings_turn_id: `${string}-${string}-${string}-${string}-${string}`;
    };
    unbilled(): void;
} | undefined;
//# sourceMappingURL=savings-turn.d.ts.map