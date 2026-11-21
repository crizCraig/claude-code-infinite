export declare const HTTPS_PROXY_MODE_ENV = "CCC_HTTPS_PROXY_MODE";
export type HttpsProxyModeDecision = {
    mode: "https-proxy";
} | {
    mode: "base-url";
    requested: false;
} | {
    mode: "base-url";
    requested: true;
    reason: string;
};
export interface EligibilityInput {
    env: NodeJS.ProcessEnv;
    /** The `httpsProxyMode` config key. */
    configured?: boolean;
    platform: NodeJS.Platform;
    /** Claude Code's arguments (a `--settings` file or JSON is read too). */
    claudeArgs: readonly string[];
    cwd: string;
    homedir?: string;
    readFile?: (file: string) => string | null;
    listDir?: (dir: string) => string[];
}
export declare function httpsProxyModeDecision(input: EligibilityInput): HttpsProxyModeDecision;
/** `CCC_HTTPS_PROXY_MODE` wins (1/true/yes/on or 0/false/no/off), else the config key. */
export declare function httpsProxyModeRequested(env: NodeJS.ProcessEnv, configured?: boolean): boolean;
/** The one-line notice for a requested mode that was skipped. */
export declare function skippedNoticeText(reason: string): string;
/** Every `--settings <value>` / `--settings=<value>` before a `--`. */
export declare function settingsArgs(args: readonly string[]): string[];
//# sourceMappingURL=https-proxy-eligibility.d.ts.map