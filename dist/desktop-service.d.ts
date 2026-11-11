import { type ProxyOptions } from "./proxy.js";
export type DesktopMode = "production" | "staging" | "local";
export interface DesktopPaths {
    dir: string;
    caPem: string;
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
/** The lines to paste into Desktop's environment editor (one KEY=value per line). */
export declare function desktopEnvLines(paths: DesktopPaths, state: DesktopState): string[];
/** One shell word, literal (also as a `case` pattern: quoted, so no glob). */
export declare function shellQuote(value: string): string;
export declare function readDesktopState(paths: DesktopPaths): DesktopState | undefined;
/**
 * Make (or rotate) the CA and leaf, the token, the port and the Bash env file.
 * A re-run keeps the port and token (the pasted lines stay valid) unless
 * `rotateToken`; the CA always rotates, at the same file path.
 */
/** Rotate the CA this long before it expires (setup and the service's notice). */
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
/** Who owns the user-scope `memtree` entry in ~/.claude.json (read only; never written here). */
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
export interface DesktopServiceOptions {
    paths: DesktopPaths;
    state: DesktopState;
    memtreeBaseUrl: string;
    apiKey: string;
    /** Test-only: a loopback mock in place of api.anthropic.com. */
    upstreamOrigin?: ProxyOptions["upstreamOrigin"];
    tracePath?: string;
    debug?: boolean;
    log?: (line: string) => void;
}
export interface RunningDesktopService {
    port: number;
    sessions: () => string[];
    /** Close sessions idle for longer than `idleMs` (the sweep's job; exposed for tests). */
    closeIdle: (idleMs?: number) => Promise<void>;
    close: () => Promise<void>;
}
/**
 * The session's directory, from Claude Code's environment block ("Primary working
 * directory: ..."): in the top-level `system` text, or (Claude Code 2.1.322) in a
 * `role: "system"` entry of `messages`. Never user or assistant text.
 */
export declare function workingDirectoryFromBody(body: string): string | undefined;
export declare function startDesktopService(opts: DesktopServiceOptions): Promise<RunningDesktopService>;
//# sourceMappingURL=desktop-service.d.ts.map