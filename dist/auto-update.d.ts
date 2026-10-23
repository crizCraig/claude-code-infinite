/**
 * Automatic updates: when the startup check (update-check.ts) finds a newer
 * release, install exactly that version in the background, the way Claude
 * Code does ("✔ Update installed · Restart to update").
 *
 * Only when self-updating is safe: a plain global npm install whose package
 * directory is physically inside `<prefix>/lib/node_modules` (on Windows
 * `<prefix>\node_modules`) and writable by this user (no sudo, ever).
 * npm-linked and git checkouts (detected through the bin link too, so an
 * `npm link` is never replaced), npx and local installs, pnpm/yarn/bun/volta
 * globals and root/sudo runs get the hint line only, with the command that
 * fits how they were installed. The install runs in a detached runner
 * (auto-update-runner.ts) that loads no file from the package, so it survives
 * this ccc exiting and npm replacing the package under it.
 *
 * Windows: the runner starts only as ccc exits (also when the window is
 * closed) and waits for this process to be gone before npm runs, so npm does
 * not rewrite files under the session that started it (other running
 * sessions are as on POSIX: they already loaded their code; the shim npm
 * rewrites is identical between versions). npm is run as `node npm-cli.js` (no
 * shell: Node refuses to spawn a .cmd without one), and the runner kills
 * npm's process tree with taskkill instead of a POSIX process group.
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
export { UPDATE_LOCK_STALE_MS, acquireUpdateLock, liveLockSince, releaseUpdateLock, } from "./update-lock.js";
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
/** Set on the npm the background updater runs, so its install sends no install ping. */
export declare const AUTO_UPDATE_ENV = "CCC_AUTO_UPDATE_INSTALL";
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
    /** A launch has sent this result to diagnostics (takeUnreportedOutcome). */
    reported?: boolean;
}
export interface UpdateState {
    /** Install attempts per version (newest few kept). */
    attempts: Record<string, number>;
    last?: UpdateAttempt;
}
/** Why a launch with an update available did not install it, for diagnostics. */
export declare const SKIP_CODES: readonly ["disabled", "not-release", "linked-install", "install-method", "backoff", "max-attempts", "lock-held"];
export type SkipCode = (typeof SKIP_CODES)[number] | "no-update";
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
    code: SkipCode;
};
export interface DetectInstallOptions {
    packageDir: string;
    /**
     * The script as started (process.argv[1]), before symlinks are resolved:
     * through it an `npm link` shows even though Node reports the checkout as
     * the package directory.
     */
    scriptPath?: string;
    /**
     * Windows: test writability by creating a file (default true). Diagnostics
     * pass false, so a launch with no update writes nothing into the package.
     */
    probeWrites?: boolean;
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
    /** liveLockSince: when the install lock was taken, if it is held. */
    lockHeldSince?: number | null;
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
    windowsHide: boolean;
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
    /** Arguments before npm's own (Windows: npm-cli.js, run by this Node). */
    npmArgs?: string[];
    platform?: NodeJS.Platform;
    /** Windows: the ccc whose exit the runner waits for before installing. */
    waitForPid?: number;
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
/** True for the installs whose files are the user's own checkout. */
export declare function isLinkedInstall(kind: InstallMethodKind): boolean;
/**
 * How to update this install by hand: never `npm i -g` over a linked checkout
 * (that replaces the link with the published package), and each package
 * manager's own command for its globals.
 */
export declare function manualUpdateCommand(kind: InstallMethodKind): string;
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
/**
 * The result of the last background install, once: "ok" or "failed" the
 * first time a launch sees it finished, then null (marked reported in the
 * state file). For diagnostics, which the detached runner cannot send.
 */
export declare function takeUnreportedOutcome(stateFile: string, lockDir?: string, now?: number): "ok" | "failed" | null;
/** The version in `<packageDir>/package.json`, or null. */
export declare function readInstalledVersion(packageDir: string): string | null;
export declare function updateFiles(configDir: string): UpdateFiles;
export declare function readUpdateState(file: string): UpdateState;
/** Best effort and atomic: a failed write only loses bookkeeping. */
export declare function writeUpdateState(file: string, state: UpdateState): void;
/**
 * The `node_modules/claude-code-infinite` entry the script was started
 * through, when that entry is a symlink or junction (an `npm link`). The bin
 * itself may be a symlink (POSIX `<prefix>/bin/ccc`): one hop is followed.
 */
export declare function linkedPackageEntry(scriptPath: string): string | null;
//# sourceMappingURL=auto-update.d.ts.map