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
export interface TranscriptUsageSource {
    /** Usage for each assistant message in `messages` that the transcript knows. */
    usageFor(sessionId: string, messages: Message[]): MessageUsage;
}
/**
 * Reads transcripts incrementally: each session's file is opened once and
 * only the bytes appended since the last call are parsed.
 */
export declare class ClaudeTranscriptUsage implements TranscriptUsageSource {
    private readonly projectsDir;
    private readonly sessions;
    constructor(projectsDir?: string);
    usageFor(sessionId: string, messages: Message[]): MessageUsage;
    private indexFor;
}
/** `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
export declare function defaultProjectsDir(env?: NodeJS.ProcessEnv): string;
/** The session's transcript in whichever project directory holds it. */
export declare function findTranscript(projectsDir: string, sessionId: string): string | undefined;
//# sourceMappingURL=transcript-usage.d.ts.map