export type DesktopMode = "production" | "staging" | "local";
export interface DesktopPaths {
    dir: string;
    /** The pasted NODE_EXTRA_CA_CERTS: the user's own extra CAs at setup, then ccc's CA. */
    caPem: string;
    /** ccc's CA certificate alone (public; its key was never kept). */
    caCert: string;
    /** The user's own extra CAs, for the service's own upstream TLS (only when there are some). */
    upstreamCa: string;
    leafPem: string;
    leafKey: string;
    state: string;
    bashEnv: string;
    log: string;
    plist: string;
}
export interface DesktopState {
    mode: DesktopMode;
    port: number;
    token: string;
    /** ISO times: the CA (and leaf) validity, for the rotation notice. */
    createdAt: string;
    notAfter: string;
    /** Setup registered the memtree MCP server, so compress calls may say the tools exist. */
    mcpRegistered?: boolean;
}
export declare function desktopPaths(configDir: string, mode: DesktopMode): DesktopPaths;
export declare function desktopLaunchdLabel(mode: DesktopMode): string;
/** The lines to paste into Desktop's environment editor (one KEY=value per line). */
export declare function desktopEnvLines(paths: DesktopPaths, state: DesktopState): string[];
/**
 * Bash-tool commands get the session's env minus ccc's proxy and CA (else curl, Python
 * and others would fail TLS to api.anthropic.com), each only while it still holds ccc's
 * value (Claude Code's sandbox sets its own first; the token is matched by pattern, never
 * written). Programs started from Bash (a nested `claude -p`, an SDK script) aren't routed
 * through ccc, so they get Claude Code's own compaction back.
 */
export declare function desktopBashEnvScript(paths: DesktopPaths, state: DesktopState, userEnv?: DesktopUserEnv): string;
/** The shell values setup saw that the pasted lines replace for the session. */
export interface DesktopUserEnv {
    NODE_EXTRA_CA_CERTS?: string;
    CLAUDE_ENV_FILE?: string;
}
export declare function readDesktopState(paths: DesktopPaths): DesktopState | undefined;
/** Setup rotates the CA when it expires within this. */
export declare const CA_ROTATE_BEFORE_MS: number;
/**
 * Make the CA and leaf, the token, the port and the Bash env file. A re-run keeps
 * the port and token (the pasted lines stay valid) unless `rotateToken`, and keeps
 * the CA (live sessions trust only the one they started with) unless `rotateCa`,
 * it is missing or unreadable, or it expires within CA_ROTATE_BEFORE_MS.
 */
export declare function setupDesktopFiles(paths: DesktopPaths, mode: DesktopMode, opts?: {
    rotateToken?: boolean;
    rotateCa?: boolean;
    userExtraCaPem?: string;
    userEnv?: DesktopUserEnv;
}): Promise<DesktopState & {
    caRotated: boolean;
}>;
export declare function writeDesktopState(paths: DesktopPaths, state: DesktopState): void;
/** The launchd agent: `node <cli.js> [staging|local] desktop serve`, kept alive. */
export declare function launchdPlist(mode: DesktopMode, paths: DesktopPaths, cliPath: string): string;
export declare function installLaunchAgent(mode: DesktopMode, paths: DesktopPaths, cliPath: string): void;
export declare function uninstallLaunchAgent(mode: DesktopMode, paths: DesktopPaths): void;
/**
 * The `memtree` MCP server for every Claude Code on this account (Desktop
 * re-delivers ~/.claude.json's stdio servers to its sessions). It is inert
 * (no tools) unless the session's HTTPS_PROXY is a ccc proxy or it runs
 * under terminal ccc (memtree-mcp.ts desktopMcpTarget). Registered through
 * `claude mcp add-json --scope user`, never by editing ~/.claude.json directly.
 */
export declare function desktopMcpServerJson(): string;
/** The file `claude mcp --scope user` edits: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. */
export declare function userClaudeJsonPath(env?: NodeJS.ProcessEnv): string;
/**
 * Who owns the user-scope `memtree` entry (read only; never written here). A file that
 * exists but can't be read or parsed is "other": ccc then touches nothing.
 */
export declare function userMcpOwner(claudeJsonPath?: string): "none" | "ccc-desktop" | "other";
/**
 * Register (or refresh) ccc's entry. Someone else's `memtree` entry is left alone
 * (false, with the reason): the user decides.
 */
export declare function registerDesktopMcp(claudeCommand: string, env?: NodeJS.ProcessEnv): {
    ok: boolean;
    reason?: string;
};
/** Remove ccc's entry only, and only when no other ccc desktop mode still uses it. */
export declare function unregisterDesktopMcp(claudeCommand: string, otherModesInstalled: boolean, env?: NodeJS.ProcessEnv): void;
//# sourceMappingURL=desktop-setup.d.ts.map