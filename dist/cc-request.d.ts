/** Characters of system prompt kept for auditing a suspected side request. */
export declare const SYSTEM_HEAD_CHARS = 120;
export interface ClaudeCodeRequestInfo {
    /** A Claude Code billing header was found in the system prompt. */
    billingHeader: boolean;
    ccVersion?: string;
    entrypoint?: string;
    /** `cc_turn_origin`, e.g. "human"; absent on side requests seen so far. */
    turnOrigin?: string;
    /** `cc_prompt_id` was present (the value itself is not logged). */
    promptId: boolean;
    /** Number of tool definitions sent; the main agent always sends its tools. */
    tools: number;
    /**
     * Header present but no turn origin: the shape of the security monitor.
     * Logged only, for now.
     */
    suspectedSideRequest: boolean;
    /**
     * Opening of the system prompt after the header, one line, only for a
     * suspected side request (e.g. "You are a security monitor for autonomous
     * AI coding agents."). Local log only.
     */
    systemHead?: string;
    /**
     * For a request with a header but no turn origin: the opening of its last
     * user message (reminders removed), its message count, and a short hash of
     * the session id. Recaps, /btw and background-notification turns share the
     * main system prompt and differ only here. Local log only.
     */
    lastUserHead?: string;
    messageCount?: number;
    sessionTag?: string;
}
export declare function describeClaudeCodeRequest(body: Record<string, any>): ClaudeCodeRequestInfo;
/** A short, non-reversible tag grouping requests of one session in the log. */
export declare function sessionTag(sessionId: string | undefined): string | undefined;
/**
 * Claude Code's own side request (the auto-mode security monitor): a billing
 * header, no turn origin, and no tools. The proxy forwards these untouched
 * and never involves MemTree or the main thread's route state.
 */
export declare function isClaudeCodeSideRequest(info: ClaudeCodeRequestInfo): boolean;
/**
 * Shape of the monitor's `<transcript>` block, checked on every side request
 * so a change in Claude Code's internal format shows up in the request log
 * before anything relies on it. Observed on 2.1.281: one user message holding
 * `<transcript>`, then one single-key JSON object per line (`{"user": ...}`,
 * `{"<ToolName>": <input>}`, `{"meta": ...}`), then `</transcript>` and the
 * grading instructions.
 */
export interface TranscriptShape {
    ok: boolean;
    /** Why the shape was not recognised; absent when ok. */
    reason?: "no-transcript" | "unclosed" | "bad-line" | "empty";
    lines: number;
    userLines: number;
    toolLines: number;
    metaLines: number;
    /** For a bad line: its 1-based index inside the block and its opening. */
    badLine?: number;
    sample?: string;
}
export declare function inspectMonitorTranscript(body: Record<string, any>): TranscriptShape;
/**
 * What the MemTree server stores about a request's client (usage_requests
 * .client_meta), sent as one `x-client-meta` JSON header. Only short
 * printable-ASCII values go out, so the header is always valid.
 */
export interface MemtreeClientMeta {
    claude_code_version?: string;
    entrypoint?: string;
    turn_origin?: string;
    lane?: string;
    agent_id?: string;
    parent_agent_id?: string;
    requested_model?: string;
}
export declare function memtreeClientMeta(input: {
    info?: ClaudeCodeRequestInfo;
    lane?: string;
    agentId?: string;
    parentAgentId?: string;
    model?: unknown;
}): MemtreeClientMeta;
//# sourceMappingURL=cc-request.d.ts.map