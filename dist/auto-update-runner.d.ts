/**
 * The detached background installer for auto-update.ts, as source text that
 * ccc runs with `node -e RUNNER_SOURCE <config json>`.
 *
 * Self-contained on purpose: it requires only Node built-ins and reads no file
 * from the ccc package, because the npm install it runs replaces that package.
 * It outlives the ccc that started it (detached, own process group), records
 * the result in update-state.json and releases the lock by its token.
 *
 * Steps: re-validate the version; confirm `npm root -g` is the directory this
 * ccc lives in and that the entry there is not a symlink (an `npm link`); run
 * `npm install --global --prefix=<that prefix> claude-code-infinite@<version>
 * --no-fund --no-audit` (argv, never a shell); confirm the package.json now
 * says that version. Any failure is recorded with a short reason.
 *
 * Bounded: npm runs in its own process group and a timeout sends the group
 * SIGTERM, then SIGKILL; a hard deadline (and SIGTERM/SIGINT/SIGHUP to the
 * runner) records a failure, frees the lock and exits, so the lock's stale
 * age (auto-update.ts UPDATE_LOCK_STALE_MS) is never reached by a live runner.
 */
/** What ccc passes the runner, as JSON in argv[1]. */
export interface RunnerConfig {
    npm: string;
    packageName: string;
    version: string;
    packageDir: string;
    npmRoot: string;
    prefix: string;
    stateFile: string;
    lockFile: string;
    logFile: string;
    token: string;
    timeoutMs: number;
    /** Test-only: SIGTERM→SIGKILL and SIGKILL→give-up waits (default 10 s, 5 s). */
    killGraceMs?: number;
    pipeGraceMs?: number;
}
export declare const RUNNER_SOURCE: string;
//# sourceMappingURL=auto-update-runner.d.ts.map