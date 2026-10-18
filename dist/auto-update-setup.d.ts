/**
 * Launch-time glue for auto-update.ts: decide what this interactive launch
 * does about an available update, what the SessionStart banner says now, and
 * when the background install starts (after Claude Code is up, never on the
 * startup path; on Windows only as ccc exits, see auto-update.ts).
 */
import { AutoUpdateNotices, type AutoUpdateConfig, type AutoUpdateDecision, type InstallMethod, type SpawnLike, type StartInstallResult } from "./auto-update.js";
import { type UpdateAvailable } from "./update-check.js";
export interface AutoUpdateSetupOptions {
    update: UpdateAvailable | null;
    currentVersion: string;
    config: AutoUpdateConfig;
    configDir: string;
    color: boolean;
    env?: NodeJS.ProcessEnv;
    packageDir?: string;
    now?: () => number;
    spawnImpl?: SpawnLike;
    platform?: NodeJS.Platform;
    uid?: number;
    /** process.argv[1], to see an `npm link` through the bin (detectInstallMethod). */
    scriptPath?: string;
    /** This process (Windows: the runner waits for it to exit). */
    pid?: number;
}
export interface AutoUpdateSetup {
    decision: AutoUpdateDecision;
    /** Detected only when there is an update to act on. */
    method: InstallMethod | null;
    /** The banner's hint line: shown unless an install is about to run. */
    bannerUpdate: UpdateAvailable | null;
    /** The banner's "✔ installed" line, when an earlier install already landed. */
    bannerInstalled: string | null;
    /** The SessionStart line for later hooks in this process (proxy option). */
    notices: AutoUpdateNotices;
    /**
     * Start the planned install after `delayMs`; a no-op unless planned, and on
     * Windows, where it starts in installOnExit instead.
     */
    scheduleInstall(delayMs?: number, onResult?: (result: StartInstallResult) => void): void;
    /**
     * Windows: start the planned install now, as ccc exits; the runner waits for
     * this process to be gone. A no-op elsewhere or unless planned.
     */
    installOnExit(onResult?: (result: StartInstallResult) => void): void;
    /** One line naming the install method and the decision, for --debug. */
    debugLine: string;
}
export declare function setupAutoUpdate(opts: AutoUpdateSetupOptions): AutoUpdateSetup;
//# sourceMappingURL=auto-update-setup.d.ts.map