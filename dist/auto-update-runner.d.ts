/**
 * The detached background installer for auto-update.ts, as source text that
 * ccc runs with `node -e RUNNER_SOURCE <config json>`.
 *
 * Self-contained on purpose: it requires only Node built-ins and reads no file
 * from the ccc package, because the npm install it runs replaces that package.
 * It outlives the ccc that started it (detached, own process group), records
 * the result in update-state.json and releases the lock by its token.
 *
 * Ownership: the launcher created this runner's lock entry and records the
 * runner's pid in it right after spawning; the runner waits for that handoff,
 * exits without touching anything if the entry is gone, and re-checks the
 * entry before every npm command. Once stopping (abort or lost lock) it never
 * starts another command.
 *
 * Steps: re-validate the version; confirm `npm root -g` is the directory this
 * ccc lives in and that the entry there is not a symlink (an `npm link`); run
 * `npm install --global --prefix=<that prefix> claude-code-infinite@<version>
 * --no-fund --no-audit` (argv, never a shell); confirm the package.json now
 * says that version. Any failure is recorded with a short reason.
 *
 * Bounded: each npm command runs in its own process group, recorded in the
 * lock entry. When it ends (or times out) the whole group is reaped: SIGTERM,
 * then SIGKILL, until no member is left, so a descendant that outlives npm
 * cannot go on writing the package. The lock is released only once the group
 * is confirmed gone; otherwise the entry stays live for as long as the group
 * is (update-lock.ts). A hard deadline and SIGTERM/SIGINT/SIGHUP to the runner
 * kill the group, record a failure and exit, so the lock's stale age is never
 * reached by a live runner.
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
    /** update-lock.ts directory; this runner owns `<lockDir>/<token>.json`. */
    lockDir: string;
    logFile: string;
    token: string;
    timeoutMs: number;
    /** Test-only: how long to wait for the launcher's handoff (default 10 s). */
    handoffMs?: number;
    /** Test-only: SIGTERM→SIGKILL and SIGKILL→give-up waits (default 10 s, 5 s). */
    killGraceMs?: number;
    pipeGraceMs?: number;
}
export declare const RUNNER_SOURCE: string;
//# sourceMappingURL=auto-update-runner.d.ts.map