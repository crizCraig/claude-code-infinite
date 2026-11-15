/**
 * Message threads backstop (plans/2026-11-14_PLAN_message_threads.md, step 0b).
 *
 * Claude Code 2.1.325's message threads send `thread: {type:"create"}` and then
 * `{type:"continue", previous_message_id}` with only the newest messages. ccc needs every
 * request to carry the whole conversation (MemTree indexing, compression and sizing all
 * read it), so it starts Claude Code with CLAUDE_CODE_TETHER_LIVE=0. If a request carrying
 * `thread` reaches ccc anyway (the variable renamed, or a user's settings env turning it
 * back on), ccc answers with its own 400 and forwards nothing.
 *
 * Probed with real `claude -p` 2.1.325: a 400 whose `error.details.error_code` is
 * `thread_unsupported_request` makes Claude Code resend that turn without `thread` and keep
 * that agent and model stateless for the rest of the session. The error is ccc's own,
 * labelled as such (its type, `details.source` and message), not an Anthropic error type.
 */
/** The error code Claude Code reads to go stateless for the session. */
export declare const THREAD_UNSUPPORTED_CODE = "thread_unsupported_request";
/** "off" (default): refuse any `thread` request; "passthrough": forward it as sent. */
export type MessageThreadsMode = "off" | "passthrough";
/** One line per session in requests.jsonl, at its first refused thread request. */
export interface ThreadRefusedRecord {
    kind: "thread-refused";
    sessionTag?: string;
    /** The refused request's `thread.type` ("create", "continue", or "other"). */
    thread: string;
    model?: string;
    /** The Claude Code agent id's lane: "main", or "agent" for a subagent's request. */
    lane: "main" | "agent";
}
/** The request's `thread.type` when it carries `thread`, else undefined. */
export declare function requestThreadType(body: Record<string, any>): string | undefined;
/** The 400 body ccc answers a `thread` request with. */
export declare function threadUnsupportedBody(): string;
/** Sessions whose first refusal was logged, bounded so a long-lived proxy can't grow it. */
export declare class ThreadRefusals {
    private readonly max;
    private readonly logged;
    constructor(max?: number);
    /** True the first time a session is refused (log it then), false afterwards. */
    first(sessionId: string | undefined): boolean;
}
//# sourceMappingURL=thread-backstop.d.ts.map