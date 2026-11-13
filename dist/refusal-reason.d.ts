/**
 * Indexing rate assumed when the server gave no estimate: about what we tell partners
 * (polychat reports/2026-11-11_partner_traffic_sim.md, "Indexing (~40k tokens a minute)").
 * The server's own default is faster (index_rates.py: 12 min per 1M own-work tokens, ~83k a
 * minute); the slower figure keeps a client-side guess from promising too little.
 */
export declare const INDEX_TOKENS_PER_MINUTE = 40000;
export type RefusalCause = {
    kind: "indexing";
    secondsLeft?: number;
    unindexedTokens?: number;
} | {
    kind: "upload-timeout";
    bytes: number;
    ms: number;
    nextBudgetMs?: number;
} | {
    kind: "slow-answer";
    ms: number;
} | {
    kind: "rebuilding";
    secondsLeft?: number;
} | {
    kind: "compress-failed";
    status?: number;
} | {
    kind: "over-budget";
    inputTokens: number;
    contextTokens: number;
};
/** The parts of a request's log record (reqlog MessagesRecord) a refusal is judged by. */
export interface RefusalEvidence {
    compaction?: {
        reason?: string;
    };
    compress?: {
        ok: boolean;
        timedOut: boolean;
        ms: number;
        refused?: true;
        status?: number;
        /** A large upload that spent its whole long budget (slow-upload.ts), not just slow. */
        uploadTimeout?: true;
    };
    indexBehind?: true;
    /** The compress answer's index lag: the server's memory ETA and the un-indexed tokens. */
    indexLag?: {
        etaSeconds?: number;
        unindexedTokens?: number;
    };
    requestBytes?: number;
}
export interface RefusalFacts {
    inputTokens: number;
    modelContextLimit: number;
    /** Seconds of indexing MemTree last said were left (an indexing 413), if any. */
    indexSecondsLeft?: number;
    /** The budget the next compress of this session gets after an upload timeout. */
    nextCompressBudgetMs?: number;
}
/** Which cause explains this refusal (first match wins). */
export declare function refusalCause(rec: RefusalEvidence, facts: RefusalFacts): RefusalCause;
/** The refusal's one line, ending with where the session's MemTree page is. */
export declare function refusalMessage(cause: RefusalCause, sessionLink?: string): string;
/** "1.2M", "480k", "900": rounded for a one-line message. */
export declare function tokensText(tokens: number): string;
/** "3 min", "1.5 h": minutes rounded up, hours from two on. */
export declare function durationText(seconds: number): string;
//# sourceMappingURL=refusal-reason.d.ts.map