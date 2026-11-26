/** What `install` puts in settings.json. */
export declare const STATUSLINE_COMMAND = "ccc statusline";
/** The link's text where the terminal shows OSC 8 hyperlinks. */
export declare const STATUSLINE_LABEL = "\uD83C\uDF3F tree";
export declare const STATUSLINE_SEPARATOR = " | ";
/**
 * Set for the wrapped command: a `ccc statusline` inside it (a wrapped command that itself
 * calls ccc's, under another spelling) prints nothing instead of recursing.
 */
export declare const WRAPPED_ENV = "CCC_STATUSLINE_WRAPPED";
export interface StatuslinePaths {
    /** Claude Code's user settings (CLAUDE_CONFIG_DIR/settings.json or ~/.claude/settings.json). */
    settings: string;
    /** The wrapped original statusLine, saved by install (in ccc's config dir). */
    saved: string;
    /** The cached links (status-link.ts). */
    links?: string;
}
export declare function statuslinePaths(env?: NodeJS.ProcessEnv): StatuslinePaths;
/** `ccc statusline [install|uninstall]`; returns the exit code. */
export declare function statuslineMain(args: string[], paths?: StatuslinePaths, out?: (text: string) => unknown): Promise<number>;
/** The status line: the wrapped command's output, then the session's link. */
export declare function renderStatusline(input: string, paths: StatuslinePaths, env?: NodeJS.ProcessEnv): Promise<string>;
/** ` 🌿 tree` linked to the session's page, or the URL; "" with no cached link. */
export declare function linkSegment(sessionId: unknown, env?: NodeJS.ProcessEnv, dir?: string): string;
/**
 * Point Claude Code's statusLine at `ccc statusline`, saving the current one to wrap.
 * Re-running is harmless; a statusLine that is not a command is left alone.
 */
export declare function installStatusline(paths: StatuslinePaths, platform?: NodeJS.Platform): {
    ok: boolean;
    message: string;
};
/** Put back the statusLine install replaced (or remove ours when there was none). */
export declare function uninstallStatusline(paths: StatuslinePaths): {
    ok: boolean;
    message: string;
};
/**
 * The wrapped command's stdout, trailing newlines trimmed ("" if it fails). Run in its own
 * process group, so a timeout kills everything it started (no pile-up across refreshes).
 */
export declare function runWrapped(command: string, input: string, timeoutMs?: number): Promise<string>;
/** `pid` and every descendant (from `ps`; just `pid` where there is none, e.g. Windows). */
export declare function processTree(pid: number | undefined): number[];
/**
 * Whether auto-install should preserve a command that already includes ccc's link.
 */
export declare function statusLineWantsLink(settingsFile?: string): boolean;
/**
 * Whether the effective status line (`--settings`, then enabled sources from
 * project local -> project -> user) shows ccc's link.
 */
export declare function effectiveStatusLineWantsLink(userSettings?: string, cwd?: string, claudeArgs?: readonly string[]): boolean;
export interface StatusLinkConfig {
    /** Write `<config>/statusline/<session>.url` and check heartbeats on Stop. */
    enabled: boolean;
    /** Refresh newest-tree lookups per minute during `/v1/messages` tool loops. */
    refresh: boolean;
}
/**
 * Decide status-line link file writing and per-request refresh for a session.
 * Interactive sessions always write the link file (for manual README snippets incl. Windows,
 * CCC_STATUSLINE_AUTO=0 installs, and project-scope status lines). Display-only lookups run
 * only when the effective status line is known to show the link or CCC_STATUSLINE_REFRESH=1.
 * Headless/non-interactive runs have no status line and do no status-link file work.
 */
export declare function resolveStatusLinkConfig(opts: {
    interactive: boolean;
    userSettings: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    claudeArgs?: readonly string[];
}): StatusLinkConfig;
//# sourceMappingURL=statusline.d.ts.map