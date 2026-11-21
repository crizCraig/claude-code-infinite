export declare const RECALL_ACTIVE = "CCC_RECALL_HOOKS_ACTIVE";
export declare const RECALL_WRAPPED = "CCC_RECALL_WRAPPED";
export declare const RECALL_MATCHER = "^mcp__memtree__(search|read_node|read_lines)$";
interface Passage {
    session: string;
    label: string;
    at?: string;
}
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
    tool_response?: unknown;
}
export declare function waitForRecall(work: Promise<unknown>): Promise<void>;
export declare class RecallWork {
    private readonly pending;
    start(write: (signal: AbortSignal) => Promise<void>): Promise<void> | undefined;
    settle(): Promise<void>;
}
export interface RecallInvocation {
    account: string;
    session: string;
    /** stdio sends the unmodified answer before publishing its receipt. */
    afterReply?: (write: (signal?: AbortSignal) => Promise<void>) => void;
}
export declare function beginRecall(input: RecallHook, account: string): Promise<void>;
export declare function recallToolEnabled(tool: unknown, id: unknown, env: NodeJS.ProcessEnv): id is string;
export declare function withRecallReceipt(tool: string, id: unknown, answer: () => Promise<string>, invocation?: RecallInvocation): Promise<string>;
export declare function recallPassage(session: unknown, summary: unknown, at: unknown): void;
export interface RecallBatch extends Passage {
    count: number;
}
export declare const wrappedRecallWork: RecallWork;
export declare function settleRecallWork(): Promise<void>;
export declare function recalled(input: RecallHook, account: string): Promise<RecallBatch | undefined>;
export declare function pastRecallCount(session: string | undefined, account: string): number;
export declare function recallLine(batches: RecallBatch[], now?: Date): string | undefined;
/** Reserve known prompts during receipt verification. Even two proxies
 * processing the same host prompt must win its exclusive on-disk marker first.
 * Late agents have no parent prompt ID until Stop, so load display history for
 * their session in advance and remember their eventual assignment in memory. */
export declare class WrappedRecallHistory {
    private readonly reservations;
    private readonly ready;
    private readonly shown;
    prepare(session: string, prompt: string, signal: AbortSignal): Promise<void>;
    prepareAgent(session: string): Promise<void>;
    claim(session: string, prompt: string): boolean;
}
/** Direct hooks run in separate processes. Only the Stop that creates this
 * marker can announce the prompt, including after a resume. */
export declare function claimRecallPrompt(session: string, prompt: string, signal?: AbortSignal): Promise<boolean>;
/** Only the matching prompt owns host calls. Background agents can finish after
 * that prompt's Stop, so the next parent Stop in the same session can claim them. */
export declare function standaloneRecall(input: RecallHook, account: string): Promise<string | undefined>;
export declare function standaloneRecallHook(): Promise<void>;
export {};
//# sourceMappingURL=recall.d.ts.map