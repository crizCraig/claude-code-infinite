/**
 * npm install ping: when npm installs ccc (its postinstall), one anonymous
 * "installed" diagnostics event, so polychat can see installs that never run
 * (polychat docs/install_funnel.md).
 *
 * What is sent: the ccc version, Node version, OS, CPU architecture, how it
 * was installed (npm global, local, npx, ...), whether this machine already
 * had an install id, and that install id: the same random id ccc's
 * diagnostics use later (diagnostics.ts), so an install joins its first run.
 * No key, no paths, no env values.
 *
 * Skipped under every diagnostics opt-out (CCC_NO_DIAGNOSTICS, DO_NOT_TRACK,
 * DISABLE_TELEMETRY, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "diagnostics":
 * false), in CI, under sudo or as root (sudo drops the user's opt-outs), for
 * `npm install` inside a ccc checkout, and for ccc's own background updates. Never fails or slows the install for long: one POST
 * with a 2 s timeout, every error swallowed, and the process always exits 0.
 */
export declare const INSTALL_PING_TIMEOUT_MS = 2000;
export declare const INSTALL_PING_URL = "https://api.polychat.co/v1/ccc/diagnostics";
export interface InstallPingOptions {
    env?: NodeJS.ProcessEnv;
    /** The installed package's folder (default: the one this file is in). */
    packageDir?: string;
    /** ccc's config folder (default ~/.claude-code-infinite). */
    configDir?: string;
    platform?: NodeJS.Platform;
    uid?: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
    url?: string;
}
export type InstallPingResult = "sent" | "failed" | "opted-out" | "ci" | "dev-install" | "auto-update" | "root";
/** Send the ping (or say why not). Never throws. */
export declare function runInstallPing(opts?: InstallPingOptions): Promise<InstallPingResult>;
/** Why this install sends nothing, or null to send. */
export declare function skipReason(env: NodeJS.ProcessEnv, packageDir: string, configDir: string, opts?: {
    platform?: NodeJS.Platform;
    uid?: number;
}): Exclude<InstallPingResult, "sent" | "failed"> | null;
/** The exact batch the ping sends (polychat's /v1/ccc/diagnostics schema 1). */
export declare function installBody(env: NodeJS.ProcessEnv, packageDir: string, configDir: string, opts?: InstallPingOptions): Record<string, unknown>;
/** npm-global, npx, local, or another package manager's global (from npm's own env). */
export declare function installMethod(env: NodeJS.ProcessEnv, packageDir: string): string;
export declare function isCi(env: NodeJS.ProcessEnv): boolean;
/** `npm install` run inside a ccc checkout (its own dependencies), or a git checkout. */
export declare function isDevInstall(env: NodeJS.ProcessEnv, packageDir: string): boolean;
/** Running as root or under sudo (POSIX only). */
export declare function isRoot(env: NodeJS.ProcessEnv, opts?: {
    platform?: NodeJS.Platform;
    uid?: number;
}): boolean;
/** postinstall entry: run, then exit 0 whatever happened, at most ~2.5 s later. */
export declare function main(): void;
//# sourceMappingURL=install-ping.d.ts.map