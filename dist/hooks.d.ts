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
/** Trailer labels; kept here so hooks.ts stays free of notices.ts imports. */
export declare const TRAILER_LABEL = "\u2022 MemTree \u00B7";
/** Label on a line that carries a MemTree page link. */
export declare const LINK_LABEL = "\u2022 MemTree";
/** What the link is, said next to the label when a tree is news. */
export declare const LINK_DESCRIPTION = "this session's memory map";
/**
 * The one-time notice for a session's first tree: set apart from the routine
 * link (leaf, bold) and saying in one line why it is worth opening. Kept short
 * enough to fit 80 columns after Claude Code's "Stop says: " label.
 */
export declare const FIRST_TREE_TITLE = "\uD83C\uDF3F First MemTree ready";
export declare const FIRST_TREE_VALUE = "a searchable map of this session so far";
/** Added under the first tree a user ever sees: what to do with it. */
export declare const FIRST_EVER_HINT = "Open it, or paste the link to any agent to give it this session's context";
/**
 * Closes every URL line. Terminal linkifiers run a bare URL into whatever is
 * drawn right after it when the row joins the next one: a URL that ended a
 * hook's output once opened as `…/m/<id>` plus Claude Code's prompt border
 * (`────…❯`). A space always ends the URL, and a visible mark after it
 * survives Claude Code trimming trailing whitespace and newlines.
 */
export declare const URL_END = " \u2197";
/** An indented line carrying one URL (bare or OSC 8), closed by URL_END. */
export declare function urlLine(url: string, lead?: string): string;
/**
 * A MemTree link notice: the label (and note, if any) on the first line and
 * the URL, indented, on the next, so a long URL wraps on its own rather than
 * dragging the label or note onto a second line. Label and note come
 * pre-styled; the URL stays bare for the terminal's linkifier, closed by
 * URL_END so it is never the last thing in the output.
 */
export declare function linkLines(label: string, url: string, note?: string): string;
export declare const DEFAULT_NOTICE_TTL_MS: number;
/**
 * `/memtree`: list the MemTree commands. The link label reads `/memtree` as a
 * hint, and typing it exactly must not dead-end in "Unknown command".
 */
export declare const MEMTREE_HELP_COMMAND = "memtree";
/** The session plugin's name, which prefixes its commands in Claude Code's menu. */
export declare const SESSION_PLUGIN_NAME = "ccc";
/** `/memtree-view`: print this session's MemTree page link. */
export declare const MEMTREE_VIEW_COMMAND = "memtree-view";
/**
 * `/memtree-compact [tokens|off]`: compact this session on its next message
 * and keep that compressed history until the budget is reached again.
 */
export declare const MEMTREE_COMPACT_COMMAND = "memtree-compact";
/**
 * The arguments of a submitted `/<name>` (bare or `/ccc:`-qualified), or
 * undefined when the prompt is not that command.
 */
export declare function sessionCommandArgs(prompt: string, name: string): string | undefined;
export declare function isMemtreeViewCommand(prompt: string): boolean;
type NoticeText = string | (() => string);
/**
 * Resolves the link appended to the success line for a session at claim
 * time, or undefined when there is none. Evaluated lazily so the newest
 * value (for example a MemTree page whose index finished during the tool
 * loop) is what the user sees. The link is rendered unstyled after the
 * styled text: Claude Code linkifies bare URLs and would swallow a trailing
 * SGR reset into the link text.
 */
type LinkResolver = (sessionId: string | undefined) => SuccessLink | undefined;
/** A link to show on the success line, shown once per distinct `key`. */
export interface SuccessLink {
    /** What makes this link news — e.g. the index it stands for, not its URL. */
    key: string;
    link: string;
    /**
     * A short hint shown after the link, e.g.
     * "not used to compress this session" when the turn behind the page was
     * passed through whole.
     */
    note?: string;
}
/**
 * Introduces the first tree of each session (see FIRST_TREE_TITLE). Answers
 * whether this is the user's first tree ever, and hears when the intro was
 * shown. Failures never break a hook.
 */
export interface FirstTreeIntro {
    isFirstEver(sessionId: string | undefined): boolean;
    markShown(sessionId: string | undefined): void;
}
/**
 * Where the trailer (`• MemTree · <link>`) is shown: under every finished
 * assistant message (with Stop as the fallback for a turn that rendered no
 * text), or on Stop only, once per turn.
 */
export type TrailerPlacement = "message" | "stop" | "turn";
interface ColorCapableStream {
    hasColors?: (count?: number, env?: NodeJS.ProcessEnv) => boolean;
}
/** Respect explicit monochrome settings and Node's platform color detection. */
export declare function terminalSupportsColor(env?: NodeJS.ProcessEnv, stream?: ColorCapableStream): boolean;
/** Evaluated in the proxy's terminal, not the hook relay's piped stdout. */
export declare function terminalSupportsHyperlinks(env?: NodeJS.ProcessEnv, stream?: {
    isTTY?: boolean;
}): boolean;
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
export interface SessionStartHookInput {
    hook_event_name: "SessionStart";
    session_id: string;
    /** "startup" | "resume" | "clear" | "compact" | "fork". */
    source?: string;
    /** The session's JSONL transcript (model-context.ts reads its notices on resume). */
    transcript_path?: string;
    agent_id?: string;
    prompt_id?: string;
}
/** Before Claude Code compacts; "manual" is a typed /compact (model-context.ts). */
export interface PreCompactHookInput {
    hook_event_name: "PreCompact";
    session_id: string;
    /** "manual" | "auto". */
    trigger: string;
    agent_id?: string;
}
export type NoticeHookInput = MessageDisplayHookInput | StopHookInput | UserPromptSubmitHookInput | SubagentLifecycleHookInput | SessionStartHookInput | PreCompactHookInput;
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
    private link;
    /** Key of the last link shown; the same key is not repeated. */
    private readonly delivered;
    private trailer;
    private trailerPlacement;
    private firstTreeIntro;
    /** Key of the last trailer shown; a different key is announced as new. */
    constructor(ttlMs?: number, now?: () => number, color?: boolean);
    /** Replace stale delivery state when a new main human prompt is submitted. */
    clearForUserRequest(): void;
    /**
     * Install the per-session link that rides the success line, shown once per
     * change: `<success text> · <link>`. Unlike prefix/suffix notices it is
     * not per-prompt; it describes the conversation's current state whenever a
     * success line is next shown.
     */
    setLink(resolve: LinkResolver | null): void;
    /**
     * The link line for a resumed session, shown by the SessionStart hook
     * before any new turn. Marks the key as shown, so the next trailer under a
     * message renders dim (unchanged) rather than green (new).
     */
    resumeLine(link: SuccessLink, sessionId?: string): string;
    /** Whether the next success line would carry a link not shown before. */
    linkPending(sessionId: string | undefined): boolean;
    /**
     * Install the trailer: the newest link for the session, shown after every
     * message (or on every Stop), the first time under a new `key` marked as
     * new. Not once-per-key like the success-line link: the point is that the
     * link is always at the bottom of the screen.
     */
    setTrailer(resolve: LinkResolver | null, placement?: TrailerPlacement): void;
    /**
     * Announce the first link a session shows with the one-time first-tree
     * notice instead of the routine trailer. Off (null) by default.
     */
    setFirstTreeIntro(intro: FirstTreeIntro | null): void;
    queuePrefix(text: NoticeText, onDelivered?: () => void, promptId?: string): void;
    /** Returns a handle that `cancel` takes to withdraw this notice undelivered. */
    queueSuffix(text: NoticeText, onDelivered?: () => void, promptId?: string): object;
    /** Whether a notice for `promptId` (or for any prompt) is queued and undelivered. */
    hasPending(promptId?: string): boolean;
    /** Withdraw a queued notice that is still pending; a newer one is kept. */
    cancel(handle: object | undefined): void;
    /**
     * Claim eligible notice parts atomically for one hook invocation. Subagent
     * hooks share the plugin but must never consume the main turn's notice.
     */
    claim(input: NoticeHookInput): NoticeHookOutput | null;
    private claimForDisplay;
    private promptMatches;
    private styleSuccess;
    /** Warning text styled as a queued warning would be, for direct hook replies. */
    warningText(text: string): string;
    /**
     * Warnings get the same own-line treatment as success, in yellow. A line
     * that is only an indented URL stays bare for the terminal's linkifier.
     */
    private styleWarning;
    /**
     * The success line with the session's current MemTree page on its own
     * indented line below it (`✓ … optimized · ~813k → 408k tokens` then
     * `  <link>`), every time the line is shown. The URL stays bare for the
     * terminal's linkifier. Marks the key shown, so the end-of-turn trailer
     * does not repeat the same link.
     */
    private renderSuccess;
    /** No link has been shown for this session yet, and the first-tree intro is on. */
    private isFirstLink;
    /** The session's current link, shown or not. Resolver failures never break a hook. */
    private currentLink;
    /** The link if its key changed since last shown, without marking it. Resolver failures never break a hook. */
    private resolveLink;
    /**
     * The trailer line for this session, or undefined when there is no link.
     * The first time a key is seen the label says so in green; afterwards the
     * label is dim. The URL stays bare either way (linkifier-safe). Rendering
     * marks the key as seen. Resolver failures never break a hook.
     */
    private renderTrailer;
    /** A link that is news: green label, then what it is (dim). */
    private newLinkLabel;
    /**
     * The session's first tree: bold leaf title, the value in one line, the
     * URL below; for the user's first tree ever, one dim line on what to do.
     */
    private firstTreeNotice;
    /** Call the first-tree intro; a throwing one never breaks a hook. */
    private askIntro;
    /** The link notice with its note dim. */
    private linkNotice;
    private styleDim;
    private deliveryFor;
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
    /**
     * Forward SessionStart(resume) to the proxy so a resumed session shows
     * its MemTree link. SessionStart accepts no `http` hooks, so a tiny Node
     * script (run with this process's own Node) relays stdin to `hookUrl`.
     */
    resumeLink?: boolean;
    /**
     * Ask the proxy before a typed /compact (PreCompact, manual only), which
     * answers it with a note while MemTree compresses (model-context.ts).
     * Default on; off under CCC_AUTO_COMPACT=1, where Claude Code's own wins.
     */
    interceptCompact?: boolean;
}): SessionNoticePlugin;
/**
 * A plugin with only the SessionStart banner, for a session that runs without the
 * proxy (MemTree paused: plain Claude Code, see paused-session.ts). No http hooks,
 * commands or relays: nothing in it needs ccc's local server.
 */
export declare function createStartupBannerPlugin(startupMessage: string, opts?: {
    tempRoot?: string;
}): SessionNoticePlugin;
/** Return true only for known Claude versions that support MessageDisplay. */
export declare function supportsMessageDisplay(versionOutput: string): boolean;
export {};
//# sourceMappingURL=hooks.d.ts.map