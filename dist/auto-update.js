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
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RUNNER_SOURCE } from "./auto-update-runner.js";
import { PACKAGE_NAME, compareVersions, parseVersion, updateCheckEnabled, } from "./update-check.js";
export const DISABLE_AUTOUPDATE_ENV = "CCC_DISABLE_AUTOUPDATE";
/** Claude Code's own opt-out, honored too. */
export const CLAUDE_DISABLE_AUTOUPDATER_ENV = "DISABLE_AUTOUPDATER";
export const UPDATE_STATE_FILE = "update-state.json";
export const UPDATE_LOCK_FILE = "update.lock";
export const UPDATE_LOG_FILE = "auto-update.log";
export const AUTO_UPDATE_BACKOFF_MS = 24 * 60 * 60 * 1000;
export const MAX_ATTEMPTS_PER_VERSION = 2;
/** Longer than the runner's install timeout, so a live install is never stolen. */
export const UPDATE_LOCK_STALE_MS = 15 * 60 * 1000;
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/** A lock whose holder is gone is stale after this grace (pid reuse is rare). */
const DEAD_HOLDER_GRACE_MS = 30 * 1000;
/** Wait after launch so the install never competes with Claude Code starting. */
export const AUTO_UPDATE_DELAY_MS = 5_000;
const VERSIONS_KEPT = 8;
/** This package's own directory (dist/..), as Node resolved it. */
export const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
// A plain release, nothing else: it becomes an npm argument, so no tag, range,
// prefix, prerelease, whitespace or shell metacharacter can pass.
const STRICT_VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
/** False when any opt-out is set: ccc's, Claude Code's, or the update check's. */
export function autoUpdateEnabled(env, config) {
    if (!updateCheckEnabled(env, config))
        return false;
    if (envFlagSet(env[DISABLE_AUTOUPDATE_ENV]))
        return false;
    if (envFlagSet(env[CLAUDE_DISABLE_AUTOUPDATER_ENV]))
        return false;
    return config.autoUpdate !== false;
}
/** A release version safe to hand to npm, or null. */
export function strictReleaseVersion(version) {
    return typeof version === "string" && STRICT_VERSION_RE.test(version) ? version : null;
}
/**
 * How this copy of ccc was installed. Only "npm-global" self-updates; the
 * runner re-checks the root against `npm root -g` before installing.
 */
export function detectInstallMethod(opts) {
    const env = opts.env ?? {};
    const raw = opts.packageDir;
    if ((opts.platform ?? process.platform) === "win32") {
        return method("unsupported-platform", raw, "Windows: npm cannot safely replace a running ccc");
    }
    if (opts.uid === 0 || env.SUDO_UID !== undefined) {
        return method("root", raw, "running as root or under sudo");
    }
    const real = realpathOrNull(raw);
    if (real === null)
        return method("unknown", raw, "package directory not found");
    return classifyPackageDir(real, env);
}
/** Decide what this launch does about an available update. */
export function planAutoUpdate(opts) {
    if (!opts.update)
        return { action: "skip", reason: "no update available" };
    if (!autoUpdateEnabled(opts.env, opts.config))
        return { action: "skip", reason: "disabled" };
    const version = strictReleaseVersion(opts.update.latest);
    if (version === null)
        return { action: "skip", reason: "version is not a plain release" };
    if (opts.method.kind !== "npm-global") {
        return { action: "skip", reason: `install method ${opts.method.kind}` };
    }
    if (opts.installedVersion === version && newerThan(version, opts.update.current)) {
        return { action: "installed", version };
    }
    const blocked = attemptBlocked(opts.state, version, opts.now);
    if (blocked)
        return { action: "skip", reason: blocked };
    return { action: "install", version, method: opts.method };
}
/**
 * Take the lock, count the attempt, and start the detached runner. Never
 * throws; a failure to start is recorded like a failed install.
 */
export function startAutoUpdateInstall(opts) {
    const decision = opts.decision;
    if (decision.action !== "install" || decision.method.kind !== "npm-global")
        return "not-planned";
    const version = strictReleaseVersion(decision.version);
    if (version === null)
        return "not-planned";
    const now = (opts.now ?? Date.now)();
    const token = acquireUpdateLock(opts.files.lockFile, now);
    if (token === null)
        return "locked";
    const packageDir = decision.method.packageDir;
    recordAttemptStart(opts.files.stateFile, version, packageDir, now);
    const config = runnerConfig(opts, decision.method, version, token);
    try {
        const child = opts.spawnImpl(opts.execPath ?? process.execPath, ["-e", RUNNER_SOURCE, JSON.stringify(config)], { detached: true, stdio: "ignore", env: runnerEnv(opts.env ?? process.env, opts.execPath) });
        child.on("error", (err) => spawnFailed(opts.files, token, version, packageDir, err));
        child.unref();
        if (child.pid !== undefined)
            setLockHolder(opts.files.lockFile, token, child.pid);
        return "started";
    }
    catch (err) {
        spawnFailed(opts.files, token, version, packageDir, err);
        return "spawn-failed";
    }
}
/**
 * The SessionStart line about a background install, at most once per ccc
 * process: "✔ ccc X installed · restart ccc to use it", or after a failure
 * during this process the manual hint.
 */
export class AutoUpdateNotices {
    opts;
    shown = false;
    constructor(opts) {
        this.opts = opts;
    }
    /** The banner already carried a line: nothing more this process. */
    markShown() {
        this.shown = true;
    }
    sessionStartLine() {
        if (this.shown)
            return undefined;
        const line = this.pendingLine();
        if (line !== undefined)
            this.shown = true;
        return line;
    }
    pendingLine() {
        const last = readUpdateState(this.opts.stateFile).last;
        if (!last || !samePackageDir(last.packageDir, this.opts.packageDir))
            return undefined;
        if (!newerThan(last.version, this.opts.currentVersion))
            return undefined;
        if (last.status === "ok") {
            const read = this.opts.readInstalledVersion ?? readInstalledVersion;
            const installed = read(this.opts.packageDir);
            return installed === last.version ? this.opts.installedText(last.version) : undefined;
        }
        if (last.status === "failed" && last.at >= this.opts.startedAt) {
            return this.opts.hintText({ latest: last.version, current: this.opts.currentVersion });
        }
        return undefined;
    }
}
/** The version in `<packageDir>/package.json`, or null. */
export function readInstalledVersion(packageDir) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
        return pkg?.name === PACKAGE_NAME ? strictReleaseVersion(pkg.version) : null;
    }
    catch {
        return null;
    }
}
export function updateFiles(configDir) {
    return {
        stateFile: path.join(configDir, UPDATE_STATE_FILE),
        lockFile: path.join(configDir, UPDATE_LOCK_FILE),
        logFile: path.join(configDir, UPDATE_LOG_FILE),
    };
}
export function readUpdateState(file) {
    try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        return { attempts: cleanAttempts(data?.attempts), last: cleanAttempt(data?.last) };
    }
    catch {
        return { attempts: {} };
    }
}
/** Best effort and atomic: a failed write only loses bookkeeping. */
export function writeUpdateState(file, state) {
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
        fs.renameSync(tmp, file);
    }
    catch {
        fs.rmSync(tmp, { force: true });
    }
}
/**
 * Create the lock exclusively, stealing it once when stale (too old, or its
 * holder has exited). Returns the owner token, or null when another session
 * holds it.
 */
export function acquireUpdateLock(lockFile, now) {
    const token = randomUUID();
    if (createLock(lockFile, token, now))
        return token;
    const held = readLock(lockFile);
    if (held === null ? !unreadableLockIsStale(lockFile, now) : !lockIsStale(held, now))
        return null;
    if (!stealLock(lockFile, held))
        return null;
    return createLock(lockFile, token, now) ? token : null;
}
/** Remove the lock only when this token still owns it. */
export function releaseUpdateLock(lockFile, token) {
    if (readLock(lockFile)?.token === token)
        fs.rmSync(lockFile, { force: true });
}
// ---------------------------------------------------------------------------
// Install-method detection
// ---------------------------------------------------------------------------
function classifyPackageDir(real, env) {
    if (fs.existsSync(path.join(real, ".git"))) {
        return method("git-checkout", real, "package directory is a git checkout");
    }
    const manager = otherPackageManager(real, env);
    if (manager)
        return method(manager, real, `installed by ${manager}`);
    const parent = path.dirname(real);
    if (path.basename(parent) !== "node_modules" || path.basename(real) !== PACKAGE_NAME) {
        return method("npm-link", real, "package directory is outside node_modules (linked checkout)");
    }
    if (path.basename(path.dirname(parent)) !== "lib") {
        return method("local", real, "not a global npm prefix (<prefix>/lib/node_modules)");
    }
    const prefix = path.dirname(path.dirname(parent));
    const unwritable = firstUnwritable([parent, real, path.join(real, "dist"), path.join(prefix, "bin")]);
    if (unwritable)
        return method("not-writable", real, `${unwritable} is not writable without sudo`);
    return { kind: "npm-global", packageDir: real, detail: `npm prefix ${prefix}`, npmRoot: parent, prefix };
}
function otherPackageManager(real, env) {
    const p = real.split(path.sep).join("/");
    if (p.includes("/_npx/"))
        return "npx";
    if (/\/\.?pnpm\//.test(p) || p.includes("/.pnpm-global/"))
        return "pnpm";
    if (/\/\.yarn\//.test(p) || /\/yarn\/global\//.test(p) || p.includes("/.config/yarn/"))
        return "yarn";
    if (p.includes("/.bun/"))
        return "bun";
    const volta = env.VOLTA_HOME && realpathOrNull(env.VOLTA_HOME);
    if (p.includes("/.volta/") || (volta && isInside(real, volta)))
        return "volta";
    return null;
}
function firstUnwritable(dirs) {
    for (const dir of dirs) {
        try {
            fs.accessSync(dir, fs.constants.W_OK);
        }
        catch {
            return dir;
        }
    }
    return null;
}
function method(kind, packageDir, detail) {
    return { kind, packageDir, detail };
}
// ---------------------------------------------------------------------------
// Attempts, backoff and state
// ---------------------------------------------------------------------------
/** Why this version must not be tried now, or null. */
function attemptBlocked(state, version, now) {
    if ((state.attempts[version] ?? 0) >= MAX_ATTEMPTS_PER_VERSION) {
        return `already tried ${version} ${MAX_ATTEMPTS_PER_VERSION} times`;
    }
    const last = state.last;
    if (!last)
        return null;
    // A run that never reported (killed, machine asleep) counts as a failure
    // once its lock would be stale.
    const failedAt = last.status === "failed" ? last.at
        : last.status === "running" && now - last.at > UPDATE_LOCK_STALE_MS ? last.at
            : null;
    if (failedAt !== null && now - failedAt < AUTO_UPDATE_BACKOFF_MS) {
        return "backing off for a day after a failed install";
    }
    return null;
}
function recordAttemptStart(file, version, packageDir, now) {
    const state = readUpdateState(file);
    state.attempts[version] = (state.attempts[version] ?? 0) + 1;
    state.attempts = newestAttempts(state.attempts);
    state.last = { version, status: "running", at: now, packageDir };
    writeUpdateState(file, state);
}
function spawnFailed(files, token, version, packageDir, err) {
    const state = readUpdateState(files.stateFile);
    const error = `could not start the installer: ${String(err).slice(0, 200)}`;
    state.last = { version, status: "failed", at: Date.now(), packageDir, error };
    writeUpdateState(files.stateFile, state);
    releaseUpdateLock(files.lockFile, token);
}
function newestAttempts(attempts) {
    const versions = Object.keys(attempts).sort((a, b) => compareVersions(parseVersion(b), parseVersion(a)));
    return Object.fromEntries(versions.slice(0, VERSIONS_KEPT).map((v) => [v, attempts[v]]));
}
function cleanAttempts(value) {
    if (!value || typeof value !== "object")
        return {};
    const out = {};
    for (const [version, count] of Object.entries(value)) {
        if (strictReleaseVersion(version) && Number.isInteger(count) && count > 0) {
            out[version] = count;
        }
    }
    return out;
}
function cleanAttempt(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const version = strictReleaseVersion(value.version);
    const status = ["running", "ok", "failed"].includes(value.status) ? value.status : null;
    if (!version || !status || typeof value.at !== "number" || typeof value.packageDir !== "string") {
        return undefined;
    }
    const error = typeof value.error === "string" ? value.error.slice(0, 300) : undefined;
    return { version, status, at: value.at, packageDir: value.packageDir, ...(error ? { error } : {}) };
}
// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
function runnerConfig(opts, m, version, token) {
    return {
        npm: opts.npmPath ?? defaultNpmPath(opts.execPath ?? process.execPath),
        packageName: PACKAGE_NAME,
        version,
        packageDir: m.packageDir,
        npmRoot: m.npmRoot,
        prefix: m.prefix,
        stateFile: opts.files.stateFile,
        lockFile: opts.files.lockFile,
        logFile: opts.files.logFile,
        token,
        timeoutMs: INSTALL_TIMEOUT_MS,
    };
}
/** The npm installed with this Node, so it targets the same prefix; else PATH's. */
function defaultNpmPath(execPath) {
    const beside = path.join(path.dirname(execPath), "npm");
    return fs.existsSync(beside) ? beside : "npm";
}
/** npm's `#!/usr/bin/env node` must find this same Node first. */
function runnerEnv(env, execPath = process.execPath) {
    const bin = path.dirname(execPath);
    return {
        ...env,
        PATH: env.PATH ? `${bin}${path.delimiter}${env.PATH}` : bin,
        npm_config_update_notifier: "false",
    };
}
function createLock(lockFile, token, now) {
    try {
        fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
        const fd = fs.openSync(lockFile, "wx", 0o600);
        try {
            fs.writeSync(fd, JSON.stringify({ token, startedAt: now, pid: process.pid }));
        }
        finally {
            fs.closeSync(fd);
        }
        return true;
    }
    catch {
        return false;
    }
}
function readLock(lockFile) {
    try {
        const data = JSON.parse(fs.readFileSync(lockFile, "utf8"));
        if (typeof data?.token !== "string" || typeof data.startedAt !== "number")
            return null;
        return { token: data.token, startedAt: data.startedAt, pid: Number.isInteger(data.pid) ? data.pid : undefined };
    }
    catch {
        return null;
    }
}
/** Point the lock at the runner, whose exit (not this session's) frees it. */
function setLockHolder(lockFile, token, pid) {
    const held = readLock(lockFile);
    if (held?.token !== token)
        return;
    const tmp = `${lockFile}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify({ ...held, pid }), { mode: 0o600 });
        fs.renameSync(tmp, lockFile);
    }
    catch {
        fs.rmSync(tmp, { force: true });
    }
}
function lockIsStale(lock, now) {
    const age = now - lock.startedAt;
    if (age > UPDATE_LOCK_STALE_MS || age < -UPDATE_LOCK_STALE_MS)
        return true;
    return lock.pid !== undefined && age > DEAD_HOLDER_GRACE_MS && !processAlive(lock.pid);
}
/** An unreadable lock may be one being written this instant: stale only once old. */
function unreadableLockIsStale(lockFile, now) {
    try {
        return now - fs.statSync(lockFile).mtimeMs > DEAD_HOLDER_GRACE_MS;
    }
    catch {
        return true; // gone: nothing to steal, so the retry below simply creates it
    }
}
/**
 * Move the stale lock aside atomically, so of two sessions stealing at once
 * only one wins; if what was moved is not the stale lock read (someone else
 * stole it and created theirs), put it back and give up.
 */
function stealLock(lockFile, stale) {
    const aside = `${lockFile}.stale.${process.pid}.${randomUUID()}`;
    try {
        fs.renameSync(lockFile, aside);
    }
    catch {
        return false;
    }
    const moved = readLock(aside);
    if (moved?.token !== stale?.token) {
        try {
            fs.linkSync(aside, lockFile);
        }
        catch {
            // The new owner's lock is lost; its runner still releases by token.
        }
        fs.rmSync(aside, { force: true });
        return false;
    }
    fs.rmSync(aside, { force: true });
    return true;
}
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === "EPERM";
    }
}
// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function newerThan(version, current) {
    const a = parseVersion(version);
    const b = parseVersion(current);
    return a !== null && b !== null && compareVersions(a, b) > 0;
}
function envFlagSet(value) {
    return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}
function realpathOrNull(p) {
    try {
        return fs.realpathSync(p);
    }
    catch {
        return null;
    }
}
function isInside(child, parent) {
    const rel = path.relative(parent, child);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
function samePackageDir(a, b) {
    return (realpathOrNull(a) ?? a) === (realpathOrNull(b) ?? b);
}
//# sourceMappingURL=auto-update.js.map