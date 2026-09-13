/**
 * Startup check for a newer claude-code-infinite release on npm.
 *
 * Detect-and-tell only: ccc is Claude Code's parent process, so a silent
 * `npm -g` write mid-session is never acceptable. The result is surfaced
 * inside Claude Code through the SessionStart banner (see notices.ts) — the
 * pre-launch terminal is covered by the TUI within a second, so a line printed
 * there is never read. Bounded by a short timeout and silent on every failure
 * (registry down, offline, malformed JSON, timeout) so startup is never gated
 * on the registry. `CCC_SKIP_UPDATE_CHECK=1` disables the fetch entirely.
 */
export declare const PACKAGE_NAME = "claude-code-infinite";
export declare const NPM_LATEST_URL = "https://registry.npmjs.org/claude-code-infinite/latest";
export declare const SKIP_UPDATE_CHECK_ENV = "CCC_SKIP_UPDATE_CHECK";
export declare const UPGRADE_COMMAND = "npm install -g claude-code-infinite";
export interface UpdateAvailable {
    /** Newest version on the registry's `latest` tag. */
    latest: string;
    /** The running client's version. */
    current: string;
}
export interface UpdateCheckOptions {
    currentVersion: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    url?: string;
}
/**
 * Resolve to the newer version when the registry's `latest` is strictly ahead
 * of `currentVersion`, else null. Never rejects.
 */
export declare function checkForUpdate(opts: UpdateCheckOptions): Promise<UpdateAvailable | null>;
/** Parse `1.2.3` (optionally `v`-prefixed / suffixed) into numeric parts. */
export declare function parseVersion(version: string): [number, number, number] | null;
/** Numeric per-component compare: negative when a < b, positive when a > b. */
export declare function compareVersions(a: [number, number, number], b: [number, number, number]): number;
//# sourceMappingURL=update-check.d.ts.map