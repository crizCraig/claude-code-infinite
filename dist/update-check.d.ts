/**
 * Startup check for a newer claude-code-infinite release on npm.
 *
 * Detect-and-tell only: ccc is Claude Code's parent process, so a silent
 * `npm -g` write mid-session is never acceptable. The result is surfaced
 * inside Claude Code through the SessionStart banner (see notices.ts) — the
 * pre-launch terminal is covered by the TUI within a second, so a line printed
 * there is never read. Bounded by a short timeout and silent on every failure
 * (registry down, offline, malformed JSON, timeout) so startup is never gated
 * on the registry. The registry's answer is cached for a day, so most starts
 * make no request at all. `CCC_NO_UPDATE_CHECK=1` (or the older
 * `CCC_SKIP_UPDATE_CHECK=1`), or `"updateCheck": false` in
 * ~/.claude-code-infinite/config.json, disables the check entirely.
 */
export declare const PACKAGE_NAME = "claude-code-infinite";
export declare const NPM_LATEST_URL = "https://registry.npmjs.org/claude-code-infinite/latest";
export declare const NO_UPDATE_CHECK_ENV = "CCC_NO_UPDATE_CHECK";
/** The original opt-out name, still honored. */
export declare const SKIP_UPDATE_CHECK_ENV = "CCC_SKIP_UPDATE_CHECK";
export declare const UPGRADE_COMMAND = "npm i -g claude-code-infinite@latest";
export declare const UPDATE_CHECK_TIMEOUT_MS = 1500;
export declare const UPDATE_CHECK_CACHE_TTL_MS: number;
export declare const UPDATE_CHECK_CACHE_FILE = "update-check.json";
export interface UpdateAvailable {
    /** Newest version on the registry's `latest` tag. */
    latest: string;
    /** The running client's version. */
    current: string;
}
/** The config.json fields this check reads. */
export interface UpdateCheckConfig {
    updateCheck?: boolean;
}
export interface UpdateCheckOptions {
    currentVersion: string;
    env?: NodeJS.ProcessEnv;
    config?: UpdateCheckConfig;
    /** Where the registry's answer is cached; no caching when omitted. */
    cacheFile?: string;
    now?: () => number;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    url?: string;
}
/**
 * Resolve to the newer version when the registry's `latest` is strictly ahead
 * of `currentVersion`, else null. Never rejects.
 */
export declare function checkForUpdate(opts: UpdateCheckOptions): Promise<UpdateAvailable | null>;
/** False when the user opted out by env (either name) or config. */
export declare function updateCheckEnabled(env: NodeJS.ProcessEnv, config: UpdateCheckConfig): boolean;
/** Parse `1.2.3` (optionally `v`-prefixed / suffixed) into numeric parts. */
export declare function parseVersion(version: string): [number, number, number] | null;
/** Numeric per-component compare: negative when a < b, positive when a > b. */
export declare function compareVersions(a: [number, number, number], b: [number, number, number]): number;
//# sourceMappingURL=update-check.d.ts.map