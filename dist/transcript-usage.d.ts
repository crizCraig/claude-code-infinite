import type { Message } from "./turns.js";
export interface ResponseUsage {
    output_tokens: number;
    thinking_tokens: number;
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
}
/** Keyed by the assistant message's position in the list sent to MemTree. */
export type MessageUsage = Record<string, ResponseUsage>;
/** ISO 8601 time of each message the transcript knows, keyed like MessageUsage. */
export type MessageTimes = Record<string, string>;
export interface TranscriptUsageSource {
    /** Usage for each assistant message in `messages` that the transcript knows. */
    usageFor(sessionId: string, messages: Message[], agentId?: string): MessageUsage;
    /**
     * When Claude Code wrote each message in `messages` that the transcript
     * knows; a subagent's (`agentId`) from its own transcript.
     */
    timesFor?(sessionId: string, messages: Message[], agentId?: string): MessageTimes;
    /**
     * The session's last assistant reply when it made no tool call (the answer
     * a turn ended with), as a message; read to the transcript's end.
     */
    finalReply?(sessionId: string): Message | undefined;
}
/**
 * Reads transcripts incrementally: each session's file is opened once and
 * only the bytes appended since the last call are parsed.
 */
export declare class ClaudeTranscriptUsage implements TranscriptUsageSource {
    private readonly projectsDir;
    private readonly sessions;
    constructor(projectsDir?: string);
    usageFor(sessionId: string, messages: Message[], agentId?: string): MessageUsage;
    /**
     * Reads a session's transcript to its end now, off the request path. A
     * lookup reads one bounded chunk, so without this the first requests after
     * resuming a long session see only its oldest responses and undercount the
     * thinking MemTree's budget check relies on. Best effort: never throws.
     */
    catchUp(sessionId: string): void;
    timesFor(sessionId: string, messages: Message[], agentId?: string): MessageTimes;
    finalReply(sessionId: string): Message | undefined;
    private indexFor;
}
/** `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
export declare function defaultProjectsDir(env?: NodeJS.ProcessEnv): string;
/**
 * The session's transcript in whichever project directory holds it, or with
 * `agentId`, that subagent's. The id is accepted with or without its `agent-`
 * file prefix.
 */
export declare function findTranscript(projectsDir: string, sessionId: string, agentId?: string): string | undefined;
//# sourceMappingURL=transcript-usage.d.ts.map