export declare const RECALL_ACTIVE = "CCC_RECALL_HOOKS_ACTIVE";
export declare const RECALL_WRAPPED = "CCC_RECALL_WRAPPED";
export declare const RECALL_MATCHER = "^mcp__memtree__(search|read_node|read_lines)$";
/** Optional provenance extraction must never turn a successful tool into an error,
 * even on an old or partially malformed server response. */
export declare function collectRecalls(record: () => void): void;
export interface RecallHook {
    hook_event_name?: string;
    tool_name?: string;
    tool_use_id?: string;
    session_id?: string;
    prompt_id?: string;
    agent_id?: string;
}
export declare function withRecallReceipt(tool: string, id: unknown, answer: () => Promise<string>): Promise<string>;
export declare function recallPassage(session: unknown, summary: unknown, at: unknown, excerpts: Iterable<string>, sourceTime?: string): void;
export interface RecallContext {
    original: Buffer;
    sent: Buffer;
    /** Summary-only hits can identify their original message by its transcript time. */
    sourceAt?: (at: string) => Iterable<string>;
}
export interface RecallBatch {
    label: string;
    at?: string;
    firstPast: boolean;
    count: number;
    past: number;
}
export declare function recalled(input: RecallHook, context?: RecallContext): RecallBatch | undefined;
export declare function pastRecallCount(session?: string): number;
export declare function recallLine(batches: RecallBatch[], now?: Date): string | undefined;
/** Plain Claude Code has no ccc proxy to own a turn. One file per tool
 * handles parallel calls; an exclusive marker lets only one Stop claim it. */
export declare function standaloneRecall(input: RecallHook): string | undefined;
export declare function standaloneRecallHook(): Promise<void>;
//# sourceMappingURL=recall.d.ts.map