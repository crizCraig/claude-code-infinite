/**
 * Display-only Claude Code hook support for MemTree notices.
 *
 * Notices must never be represented as Anthropic assistant content: Claude
 * Code can reuse that content for hidden requests such as away recaps. Modern
 * Claude Code releases provide MessageDisplay, whose output changes only the
 * rendered delta. Stop's top-level systemMessage is the fallback for turns
 * that never render text (for example, a tool-only response).
 */
export declare const MESSAGE_DISPLAY_MIN_VERSION = "2.1.166";
export declare const DEFAULT_NOTICE_TTL_MS: number;
type NoticeText = string | (() => string);
interface ColorCapableStream {
    hasColors?: (count?: number, env?: NodeJS.ProcessEnv) => boolean;
}
/** Respect explicit monochrome settings and Node's platform color detection. */
export declare function terminalSupportsColor(env?: NodeJS.ProcessEnv, stream?: ColorCapableStream): boolean;
export interface MessageDisplayHookInput {
    hook_event_name: "MessageDisplay";
    session_id: string;
    turn_id: string;
    message_id: string;
    index: number;
    final: boolean;
    delta: string;
    prompt_id?: string;
    agent_id?: string;
}
export interface StopHookInput {
    hook_event_name: "Stop";
    session_id: string;
    stop_hook_active?: boolean;
    prompt_id?: string;
    agent_id?: string;
}
export interface UserPromptSubmitHookInput {
    hook_event_name: "UserPromptSubmit";
    session_id: string;
    prompt: string;
    prompt_id?: string;
    agent_id?: string;
}
export interface SubagentLifecycleHookInput {
    hook_event_name: "SubagentStart" | "SubagentStop";
    session_id: string;
    agent_id: string;
    agent_type?: string;
    prompt_id?: string;
}
export type NoticeHookInput = MessageDisplayHookInput | StopHookInput | UserPromptSubmitHookInput | SubagentLifecycleHookInput;
export type MessageDisplayHookOutput = {
    hookSpecificOutput: {
        hookEventName: "MessageDisplay";
        displayContent: string;
    };
};
export type StopHookOutput = {
    systemMessage: string;
};
export type NoticeHookOutput = MessageDisplayHookOutput | StopHookOutput;
/**
 * Single-session delivery queue. Claude Code serializes main-thread turns, so
 * one replaceable pending notice is sufficient. A new user request clears any
 * stale notice; tool-result requests deliberately do not.
 */
export declare class NoticeDeliveryQueue {
    private readonly ttlMs;
    private readonly now;
    private readonly color;
    private pending;
    constructor(ttlMs?: number, now?: () => number, color?: boolean);
    /** Replace stale delivery state when a new main human prompt is submitted. */
    clearForUserRequest(): void;
    queuePrefix(text: NoticeText, onDelivered?: () => void, promptId?: string): void;
    queueSuffix(text: NoticeText, onDelivered?: () => void, promptId?: string): void;
    /**
     * Claim eligible notice parts atomically for one hook invocation. Subagent
     * hooks share the plugin but must never consume the main turn's notice.
     */
    claim(input: NoticeHookInput): NoticeHookOutput | null;
    private claimForDisplay;
    private promptMatches;
    private styleSuccess;
    /** Warnings get the same own-line treatment as success, in yellow. */
    private styleWarning;
    private style;
    private freshPending;
    private dropIfEmpty;
}
/** Strictly validate the subset of Claude hook input that delivery relies on. */
export declare function parseNoticeHookInput(value: unknown): NoticeHookInput | null;
export interface SessionNoticePlugin {
    dir: string;
    close(): void;
}
/** Prepend the repeatable global option without disturbing any user argv. */
export declare function withSessionNoticePluginArgs(args: readonly string[], pluginDir: string): string[];
/**
 * Build a minimal session-only plugin. --plugin-dir is repeatable, unlike
 * --settings (where Claude keeps only the final occurrence), so this composes
 * with all user settings and hooks.
 */
export declare function createSessionNoticePlugin(hookUrl: string, opts?: {
    messageDisplay?: boolean;
    tempRoot?: string;
    /** Session banner, rendered by Claude Code under a "SessionStart:… says:" label. */
    startupMessage?: string;
}): SessionNoticePlugin;
/** Return true only for known Claude versions that support MessageDisplay. */
export declare function supportsMessageDisplay(versionOutput: string): boolean;
export {};
//# sourceMappingURL=hooks.d.ts.map