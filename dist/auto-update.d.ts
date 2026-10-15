/**
 * Automatic updates: when the startup check (update-check.ts) finds a newer
 * release, install exactly that version in the background, the way Claude
 * Code does ("✔ Update installed · Restart to update").
 *
 * Only when self-updating is safe: a plain global npm install whose package
 * directory is physically inside `<prefix>/lib/node_modules` and writable by
 * this user (no sudo, ever). npm-linked and git checkouts, npx and local
 * installs, pnpm/yarn/bun/volta globals, root/sudo runs and Windows get the
 * hint line only. The install runs in a detached runner (auto-update-runner.ts)
 * that loads no file from the package, so it survives this ccc exiting and
 * npm replacing the package under it.
 *
 * One install at a time across sessions (a lock file with a stale timeout).
 * Every attempt is recorded in update-state.json: a failure backs off for a
 * day, and no version is tried more than twice. The result reaches running
 * sessions through the SessionStart hook (AutoUpdateNotices): "✔ ccc X
 * installed · restart ccc to use it", or on failure today's hint.
 *
 * Running sessions keep the code they started with: the proxy loads all its
 * modules at startup, and the hooks it registers are HTTP calls into it or
 * files in its own temp plugin dir. See README "Automatic updates".
 */
export { UPDATE_LOCK_STALE_MS, acquireUpdateLock, releaseUpdateLock } from "./update-lock.js";
import { type UpdateAvailable, type UpdateCheckConfig } from "./update-check.js";
export declare const DISABLE_AUTOUPDATE_ENV = "CCC_DISABLE_AUTOUPDATE";
/** Claude Code's own opt-out, honored too. */
export declare const CLAUDE_DISABLE_AUTOUPDATER_ENV = "DISABLE_AUTOUPDATER";
export declare const UPDATE_STATE_FILE = "update-state.json";
/** One entry per acquirer (update-lock.ts). */
export declare const UPDATE_LOCK_DIR = "update.lock.d";
export declare const UPDATE_LOG_FILE = "auto-update.log";
export declare const AUTO_UPDATE_BACKOFF_MS: number;
export declare const MAX_ATTEMPTS_PER_VERSION = 2;
export declare const INSTALL_TIMEOUT_MS: number;
/** Wait after launch so the install never competes with Claude Code starting. */
export declare const AUTO_UPDATE_DELAY_MS = 5000;
/** This package's own directory (dist/..), as Node resolved it. */
export declare const PACKAGE_DIR: string;
/** The config.json fields auto-update reads. */
export interface AutoUpdateConfig extends UpdateCheckConfig {
    autoUpdate?: boolean;
}
export type InstallMethodKind = "npm-global" | "npm-link" | "git-checkout" | "npx" | "local" | "pnpm" | "yarn" | "bun" | "volta" | "not-writable" | "root" | "unsupported-platform" | "unknown";
export interface InstallMethod {
    kind: InstallMethodKind;
    /** The package directory, resolved through symlinks when possible. */
    packageDir: string;
    /** Why it is (or is not) self-updatable, for the debug log. */
    detail: string;
    /** npm-global only: `<prefix>/lib/node_modules`, `<prefix>`. */
    npmRoot?: string;
    prefix?: string;
}
export type AttemptStatus = "running" | "ok" | "failed";
export interface UpdateAttempt {
    version: string;
    status: AttemptStatus;
    /** Start time while running, else completion time. */
    at: number;
    packageDir: string;
    error?: string;
}
export interface UpdateState {
    /** Install attempts per version (newest few kept). */
    attempts: Record<string, number>;
    last?: UpdateAttempt;
}
export type AutoUpdateDecision = {
    action: "install";
    version: string;
    method: InstallMethod;
} | {
    action: "installed";
    version: string;
} | {
    action: "skip";
    reason: string;
};
export interface DetectInstallOptions {
    packageDir: string;
    platform?: NodeJS.Platform;
    /** process.getuid(); undefined where there is none. */
    uid?: number;
    env?: NodeJS.ProcessEnv;
}
export interface PlanOptions {
    update: UpdateAvailable | null;
    method: InstallMethod;
    state: UpdateState;
    env: NodeJS.ProcessEnv;
    config: AutoUpdateConfig;
    now: number;
    /** The version in the package's package.json now (may be newer than running). */
    installedVersion: string | null;
}
export interface UpdateFiles {
    stateFile: string;
    lockDir: string;
    logFile: string;
}
export type SpawnLike = (command: string, args: string[], options: {
    detached: boolean;
    stdio: "ignore";
    env: NodeJS.ProcessEnv;
}) => {
    pid?: number;
    unref(): void;
    on(event: "error", cb: (err: Error) => void): unknown;
};
export interface StartInstallOptions {
    decision: AutoUpdateDecision;
    files: UpdateFiles;
    spawnImpl: SpawnLike;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
    execPath?: string;
    /** The npm to run; default the one beside this Node, else `npm` on PATH. */
    npmPath?: string;
}
export type StartInstallResult = "started" | "locked" | "not-planned" | "spawn-failed"
/** Rechecked under the lock: backed off, tried enough, or already installed. */
 | "skipped";
/** False when any opt-out is set: ccc's, Claude Code's, or the update check's. */
export declare function autoUpdateEnabled(env: NodeJS.ProcessEnv, config: AutoUpdateConfig): boolean;
/** A release version safe to hand to npm, or null. */
export declare function strictReleaseVersion(version: unknown): string | null;
/**
 * How this copy of ccc was installed. Only "npm-global" self-updates; the
 * runner re-checks the root against `npm root -g` before installing.
 */
export declare function detectInstallMethod(opts: DetectInstallOptions): InstallMethod;
/** Decide what this launch does about an available update. */
export declare function planAutoUpdate(opts: PlanOptions): AutoUpdateDecision;
/**
 * Take the lock, count the attempt, and start the detached runner. Never
 * throws; a failure to start is recorded like a failed install.
 */
export declare function startAutoUpdateInstall(opts: StartInstallOptions): StartInstallResult;
/**
 * The SessionStart line about a background install, at most once per ccc
 * process: "✔ ccc X installed · restart ccc to use it", or after a failure
 * during this process the manual hint.
 */
export declare class AutoUpdateNotices {
    private readonly opts;
    private shown;
    constructor(opts: {
        currentVersion: string;
        packageDir: string;
        stateFile: string;
        startedAt: number;
        installedText: (version: string) => string;
        hintText: (update: UpdateAvailable) => string;
        readInstalledVersion?: (packageDir: string) => string | null;
    });
    /** The banner already carried a line: nothing more this process. */
    markShown(): void;
    sessionStartLine(): string | undefined;
    private pendingLine;
}
/** The version in `<packageDir>/package.json`, or null. */
export declare function readInstalledVersion(packageDir: string): string | null;
export declare function updateFiles(configDir: string): UpdateFiles;
export declare function readUpdateState(file: string): UpdateState;
/** Best effort and atomic: a failed write only loses bookkeeping. */
export declare function writeUpdateState(file: string, state: UpdateState): void;
//# sourceMappingURL=auto-update.d.ts.map