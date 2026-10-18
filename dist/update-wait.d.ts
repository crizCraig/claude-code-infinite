/**
 * Windows starts a background update as ccc exits (auto-update.ts), and the
 * usual next step is to start ccc again at once, which would land while npm
 * is replacing the package. cli.ts waits here first: while the update lock
 * has a recent entry naming a live process, up to WAIT_MS, saying so once.
 *
 * Node built-ins only, and loaded before cli-main.js: it must run while the
 * rest of the package may be mid-replacement (a failure to load it is ignored).
 */
export declare const UPDATE_WAIT_MS = 30000;
/** Entries older than this are not a just-started install (a stuck lock shows the hint instead). */
export declare const FRESH_ENTRY_MS: number;
export interface UpdateWaitOptions {
    lockDir?: string;
    now?: () => number;
    waitMs?: number;
    pollMs?: number;
    /** Told once, when there is something to wait for. */
    onWait?: () => void;
}
/** Resolves when no fresh live install holds the lock, or after waitMs. True if it waited. */
export declare function waitForUpdateToFinish(opts?: UpdateWaitOptions): Promise<boolean>;
/** A lock entry started in the last FRESH_ENTRY_MS whose launcher, runner or npm is alive. */
export declare function installRunning(lockDir: string, now: number): boolean;
//# sourceMappingURL=update-wait.d.ts.map