/**
 * The line ccc prints after Claude Code exits, under Claude Code's own
 * "Resume this session with: claude --resume <id>": resuming with plain
 * `claude` would skip MemTree, so name the ccc form too.
 */
export interface ResumeHintOptions {
    sessionId: string | undefined;
    /** The environment ccc was started with (`ccc staging`), if not production. */
    envPrefix?: string;
    color: boolean;
}
export interface ExitResumeHintOptions {
    /** Interactive UI only: `-p`/non-TTY output must stay byte-for-byte vanilla. */
    interactive: boolean;
    sessionId: string | undefined;
    mode: "production" | "staging" | "local";
    color: boolean;
}
/** What ccc prints once Claude Code has exited, if anything. */
export declare function exitResumeHint(opts: ExitResumeHintOptions): string | undefined;
/** The hint to print, or undefined when there is no session id to offer. */
export declare function resumeHintText(opts: ResumeHintOptions): string | undefined;
/** Whether `id` looks like a Claude Code session id (safe for a terminal and a shell). */
export declare function isResumableSessionId(id: string | undefined): id is string;
//# sourceMappingURL=resume-hint.d.ts.map