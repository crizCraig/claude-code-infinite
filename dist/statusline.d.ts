/** What `install` puts in settings.json. */
export declare const STATUSLINE_COMMAND = "ccc statusline";
/** The link's text where the terminal shows OSC 8 hyperlinks. */
export declare const STATUSLINE_LABEL = "\uD83C\uDF3F tree";
export declare const STATUSLINE_SEPARATOR = " | ";
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
export declare function statuslineMain(args: string[], paths?: StatuslinePaths, out?: (text: string) => boolean): Promise<number>;
/** The status line: the wrapped command's output, then the session's link. */
export declare function renderStatusline(input: string, paths: StatuslinePaths, env?: NodeJS.ProcessEnv): string;
/** ` 🌿 tree` linked to the session's page, or the URL; "" with no cached link. */
export declare function linkSegment(sessionId: unknown, env?: NodeJS.ProcessEnv, dir?: string): string;
/**
 * Point Claude Code's statusLine at `ccc statusline`, saving the current one to wrap.
 * Re-running is harmless; a statusLine that is not a command is left alone.
 */
export declare function installStatusline(paths: StatuslinePaths): {
    ok: boolean;
    message: string;
};
/** Put back the statusLine install replaced (or remove ours when there was none). */
export declare function uninstallStatusline(paths: StatuslinePaths): {
    ok: boolean;
    message: string;
};
//# sourceMappingURL=statusline.d.ts.map