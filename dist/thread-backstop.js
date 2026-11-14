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
export const THREAD_UNSUPPORTED_CODE = "thread_unsupported_request";
/** The request's `thread.type` when it carries `thread`, else undefined. */
export function requestThreadType(body) {
    const thread = body?.thread;
    if (thread === undefined || thread === null)
        return undefined;
    const type = typeof thread === "object" ? thread.type : undefined;
    return type === "create" || type === "continue" ? type : "other";
}
/** The 400 body ccc answers a `thread` request with. */
export function threadUnsupportedBody() {
    return JSON.stringify({
        type: "error",
        error: {
            type: THREAD_UNSUPPORTED_CODE,
            message: "ccc needs full requests: Claude Code Infinite does not support message " +
                "threads (`thread`). Resend the whole conversation without `thread`.",
            details: { error_code: THREAD_UNSUPPORTED_CODE, source: "ccc" },
        },
    });
}
/** Sessions whose first refusal was logged, bounded so a long-lived proxy can't grow it. */
export class ThreadRefusals {
    max;
    logged = new Set();
    constructor(max = 1024) {
        this.max = max;
    }
    /** True the first time a session is refused (log it then), false afterwards. */
    first(sessionId) {
        const key = sessionId ?? "";
        if (this.logged.has(key))
            return false;
        if (this.logged.size >= this.max) {
            const oldest = this.logged.values().next().value;
            if (oldest !== undefined)
                this.logged.delete(oldest);
        }
        this.logged.add(key);
        return true;
    }
}
//# sourceMappingURL=thread-backstop.js.map