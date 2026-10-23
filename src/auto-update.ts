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

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RUNNER_SOURCE, type RunnerConfig } from "./auto-update-runner.js";
import {
  UPDATE_LOCK_STALE_MS,
  acquireUpdateLock,
  liveLockSince,
  releaseUpdateLock,
  setLockRunner,
} from "./update-lock.js";

export {
  UPDATE_LOCK_STALE_MS,
  acquireUpdateLock,
  liveLockSince,
  releaseUpdateLock,
} from "./update-lock.js";
import {
  PACKAGE_NAME,
  compareVersions,
  parseVersion,
  updateCheckEnabled,
  type UpdateAvailable,
  type UpdateCheckConfig,
} from "./update-check.js";

export const DISABLE_AUTOUPDATE_ENV = "CCC_DISABLE_AUTOUPDATE";
/** Claude Code's own opt-out, honored too. */
export const CLAUDE_DISABLE_AUTOUPDATER_ENV = "DISABLE_AUTOUPDATER";
export const UPDATE_STATE_FILE = "update-state.json";
/** One entry per acquirer (update-lock.ts). */
export const UPDATE_LOCK_DIR = "update.lock.d";
export const UPDATE_LOG_FILE = "auto-update.log";
export const AUTO_UPDATE_BACKOFF_MS = 24 * 60 * 60 * 1000;
export const MAX_ATTEMPTS_PER_VERSION = 2;
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/** Wait after launch so the install never competes with Claude Code starting. */
export const AUTO_UPDATE_DELAY_MS = 5_000;
const VERSIONS_KEPT = 8;

/** This package's own directory (dist/..), as Node resolved it. */
export const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
/** Set on the npm the background updater runs, so its install sends no install ping. */
export const AUTO_UPDATE_ENV = "CCC_AUTO_UPDATE_INSTALL";

// A plain release, nothing else: it becomes an npm argument, so no tag, range,
// prefix, prerelease, whitespace or shell metacharacter can pass.
const STRICT_VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/** The config.json fields auto-update reads. */
export interface AutoUpdateConfig extends UpdateCheckConfig {
  autoUpdate?: boolean;
}

export type InstallMethodKind =
  | "npm-global"
  | "npm-link"
  | "git-checkout"
  | "npx"
  | "local"
  | "pnpm"
  | "yarn"
  | "bun"
  | "volta"
  | "not-writable"
  | "root"
  | "unsupported-platform"
  | "unknown";

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
export const SKIP_CODES = [
  "disabled", "not-release", "linked-install", "install-method", "backoff", "max-attempts",
  "lock-held",
] as const;
export type SkipCode = (typeof SKIP_CODES)[number] | "no-update";

export type AutoUpdateDecision =
  | { action: "install"; version: string; method: InstallMethod }
  | { action: "installed"; version: string }
  | { action: "skip"; reason: string; code: SkipCode };

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

export type SpawnLike = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore"; env: NodeJS.ProcessEnv; windowsHide: boolean }
) => { pid?: number; unref(): void; on(event: "error", cb: (err: Error) => void): unknown };

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

export type StartInstallResult =
  | "started"
  | "locked"
  | "not-planned"
  | "spawn-failed"
  /** Rechecked under the lock: backed off, tried enough, or already installed. */
  | "skipped";

/** False when any opt-out is set: ccc's, Claude Code's, or the update check's. */
export function autoUpdateEnabled(env: NodeJS.ProcessEnv, config: AutoUpdateConfig): boolean {
  if (!updateCheckEnabled(env, config)) return false;
  if (envFlagSet(env[DISABLE_AUTOUPDATE_ENV])) return false;
  if (envFlagSet(env[CLAUDE_DISABLE_AUTOUPDATER_ENV])) return false;
  return config.autoUpdate !== false;
}

/** A release version safe to hand to npm, or null. */
export function strictReleaseVersion(version: unknown): string | null {
  return typeof version === "string" && STRICT_VERSION_RE.test(version) ? version : null;
}

/**
 * How this copy of ccc was installed. Only "npm-global" self-updates; the
 * runner re-checks the root against `npm root -g` before installing.
 */
export function detectInstallMethod(opts: DetectInstallOptions): InstallMethod {
  const env = opts.env ?? {};
  const raw = opts.packageDir;
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32" && (opts.uid === 0 || env.SUDO_UID !== undefined)) {
    return method("root", raw, "running as root or under sudo");
  }
  const real = realpathOrNull(raw);
  if (real === null) return method("unknown", raw, "package directory not found");
  // pnpm (and others) also reach the package through a symlinked entry: theirs, not a link.
  const link = opts.scriptPath ? linkedPackageEntry(opts.scriptPath) : null;
  if (link && !otherPackageManager(real, env)) {
    const git = fs.existsSync(path.join(real, ".git"));
    return method(git ? "git-checkout" : "npm-link", real, `${link} is a symlink (npm link)`);
  }
  return classifyPackageDir(real, env, platform, opts.probeWrites !== false);
}

/** True for the installs whose files are the user's own checkout. */
export function isLinkedInstall(kind: InstallMethodKind): boolean {
  return kind === "npm-link" || kind === "git-checkout";
}

/**
 * How to update this install by hand: never `npm i -g` over a linked checkout
 * (that replaces the link with the published package), and each package
 * manager's own command for its globals.
 */
export function manualUpdateCommand(kind: InstallMethodKind): string {
  const spec = `${PACKAGE_NAME}@latest`;
  switch (kind) {
    case "git-checkout":
      return "linked install: git pull && npm run build in your checkout";
    case "npm-link":
      return "linked install: update and rebuild the folder it links to";
    case "pnpm": return `pnpm add -g ${spec}`;
    case "yarn": return `yarn global add ${spec}`;
    case "bun": return `bun add -g ${spec}`;
    case "volta": return `volta install ${spec}`;
    case "npx": return `npx ${spec}`;
    default: return `npm i -g ${spec}`;
  }
}

/** Decide what this launch does about an available update. */
export function planAutoUpdate(opts: PlanOptions): AutoUpdateDecision {
  if (!opts.update) return skip("no update available", "no-update");
  if (!autoUpdateEnabled(opts.env, opts.config)) return skip("disabled", "disabled");
  const version = strictReleaseVersion(opts.update.latest);
  if (version === null) return skip("version is not a plain release", "not-release");
  if (isLinkedInstall(opts.method.kind)) return skip("linked install", "linked-install");
  if (opts.method.kind !== "npm-global") {
    return skip(`install method ${opts.method.kind}`, "install-method");
  }
  if (opts.installedVersion === version && newerThan(version, opts.update.current)) {
    return { action: "installed", version };
  }
  const blocked = attemptBlocked(opts.state, version, opts.now);
  if (blocked) return skip(blocked, blocked.startsWith("already tried") ? "max-attempts" : "backoff");
  const heldSince = opts.lockHeldSince ?? null;
  if (heldSince !== null && opts.now - heldSince > UPDATE_LOCK_STALE_MS) {
    // A live entry this old is a stuck installer or a reused pid: say so with the hint.
    return skip("the install lock has been held for over an hour", "lock-held");
  }
  return { action: "install", version, method: opts.method };
}

/**
 * Take the lock, count the attempt, and start the detached runner. Never
 * throws; a failure to start is recorded like a failed install.
 */
export function startAutoUpdateInstall(opts: StartInstallOptions): StartInstallResult {
  const decision = opts.decision;
  if (decision.action !== "install" || decision.method.kind !== "npm-global") return "not-planned";
  const version = strictReleaseVersion(decision.version);
  if (version === null) return "not-planned";
  const now = (opts.now ?? Date.now)();
  const token = acquireUpdateLock(opts.files.lockDir, now);
  if (token === null) return "locked";
  const packageDir = decision.method.packageDir;
  // The plan was made before the launch delay; other sessions may have tried,
  // failed or installed since. Only the lock holder's view is authoritative.
  if (installBlockedNow(opts.files.stateFile, packageDir, version, now) !== null) {
    releaseUpdateLock(opts.files.lockDir, token);
    return "skipped";
  }
  const npm = npmCommand(opts);
  if (npm === null) {
    spawnFailed(opts.files, token, version, packageDir, "npm-cli.js not found");
    return "spawn-failed";
  }
  recordAttemptStart(opts.files.stateFile, version, packageDir, now);
  const config = runnerConfig(opts, decision.method, version, token, npm);
  try {
    const child = opts.spawnImpl(
      opts.execPath ?? process.execPath,
      ["-e", RUNNER_SOURCE, JSON.stringify(config)],
      {
        detached: true, stdio: "ignore", windowsHide: true,
        env: runnerEnv(opts.env ?? process.env, opts.execPath, opts.platform),
      }
    );
    // A late error: this launch already reported "started", so the next one reports the failure.
    child.on("error", (err) => spawnFailed(opts.files, token, version, packageDir, err, false));
    child.unref();
    // The handoff the runner waits for: without it the runner never installs.
    if (child.pid !== undefined) setLockRunner(opts.files.lockDir, token, child.pid);
    return "started";
  } catch (err) {
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
  private shown = false;

  constructor(
    private readonly opts: {
      currentVersion: string;
      packageDir: string;
      stateFile: string;
      startedAt: number;
      installedText: (version: string) => string;
      hintText: (update: UpdateAvailable) => string;
      readInstalledVersion?: (packageDir: string) => string | null;
    }
  ) {}

  /** The banner already carried a line: nothing more this process. */
  markShown(): void {
    this.shown = true;
  }

  sessionStartLine(): string | undefined {
    if (this.shown) return undefined;
    const line = this.pendingLine();
    if (line !== undefined) this.shown = true;
    return line;
  }

  private pendingLine(): string | undefined {
    const last = readUpdateState(this.opts.stateFile).last;
    if (!last || !samePackageDir(last.packageDir, this.opts.packageDir)) return undefined;
    if (!newerThan(last.version, this.opts.currentVersion)) return undefined;
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

/**
 * The result of the last background install, once: "ok" or "failed" the
 * first time a launch sees it finished, then null (marked reported in the
 * state file). For diagnostics, which the detached runner cannot send.
 */
export function takeUnreportedOutcome(
  stateFile: string,
  lockDir?: string,
  now: number = Date.now()
): "ok" | "failed" | null {
  // An installer holding the lock may write the state file: leave it alone until it is done.
  if (lockDir !== undefined && liveLockSince(lockDir, now) !== null) return null;
  const state = readUpdateState(stateFile);
  const last = state.last;
  if (!last || last.status === "running" || last.reported) return null;
  // Re-read just before writing: an attempt started meanwhile is left as it is.
  const again = readUpdateState(stateFile);
  if (again.last?.at !== last.at || again.last.status !== last.status) return null;
  writeUpdateState(stateFile, { ...again, last: { ...again.last, reported: true } });
  return last.status;
}

/** The version in `<packageDir>/package.json`, or null. */
export function readInstalledVersion(packageDir: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
    return pkg?.name === PACKAGE_NAME ? strictReleaseVersion(pkg.version) : null;
  } catch {
    return null;
  }
}

export function updateFiles(configDir: string): UpdateFiles {
  return {
    stateFile: path.join(configDir, UPDATE_STATE_FILE),
    lockDir: path.join(configDir, UPDATE_LOCK_DIR),
    logFile: path.join(configDir, UPDATE_LOG_FILE),
  };
}

export function readUpdateState(file: string): UpdateState {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return { attempts: cleanAttempts(data?.attempts), last: cleanAttempt(data?.last) };
  } catch {
    return { attempts: {} };
  }
}

/** Best effort and atomic: a failed write only loses bookkeeping. */
export function writeUpdateState(file: string, state: UpdateState): void {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Install-method detection
// ---------------------------------------------------------------------------

function classifyPackageDir(
  real: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  probeWrites: boolean
): InstallMethod {
  if (fs.existsSync(path.join(real, ".git"))) {
    return method("git-checkout", real, "package directory is a git checkout");
  }
  const manager = otherPackageManager(real, env);
  if (manager) return method(manager, real, `installed by ${manager}`);
  const parent = path.dirname(real);
  if (path.basename(parent) !== "node_modules" || path.basename(real) !== PACKAGE_NAME) {
    return method("npm-link", real, "package directory is outside node_modules (linked checkout)");
  }
  // Windows keeps globals in <prefix>\node_modules with the shims in <prefix>.
  const windows = platform === "win32";
  if (!windows && path.basename(path.dirname(parent)) !== "lib") {
    return method("local", real, "not a global npm prefix (<prefix>/lib/node_modules)");
  }
  if (windows && !isWindowsGlobalPrefix(path.dirname(parent))) {
    return method("local", real, "not a global npm prefix (<prefix>\\node_modules with ccc.cmd)");
  }
  const prefix = windows ? path.dirname(parent) : path.dirname(path.dirname(parent));
  const bin = windows ? prefix : path.join(prefix, "bin");
  const unwritable = firstUnwritable([parent, real, path.join(real, "dist"), bin],
    windows && probeWrites);
  if (unwritable) return method("not-writable", real, `${unwritable} is not writable without sudo`);
  return { kind: "npm-global", packageDir: real, detail: `npm prefix ${prefix}`, npmRoot: parent, prefix };
}

function otherPackageManager(real: string, env: NodeJS.ProcessEnv): InstallMethodKind | null {
  // Case-insensitive, with Windows' folders too (%LOCALAPPDATA%\Yarn\Data\global, \Volta\).
  const p = real.split(path.sep).join("/").toLowerCase();
  if (p.includes("/_npx/")) return "npx";
  if (/\/\.?pnpm\//.test(p) || p.includes("/.pnpm-global/")) return "pnpm";
  if (/\/\.yarn\//.test(p) || /\/yarn\/(data\/)?global\//.test(p) || p.includes("/.config/yarn/")) {
    return "yarn";
  }
  if (p.includes("/.bun/")) return "bun";
  const volta = env.VOLTA_HOME && realpathOrNull(env.VOLTA_HOME);
  if (/\/\.?volta\//.test(p) || (volta && isInside(real, volta))) return "volta";
  return null;
}

/** A Windows npm prefix has the package's shim beside its node_modules. */
function isWindowsGlobalPrefix(prefix: string): boolean {
  return fs.existsSync(path.join(prefix, "ccc.cmd")) || fs.existsSync(path.join(prefix, "ccc.ps1"));
}

/**
 * The `node_modules/claude-code-infinite` entry the script was started
 * through, when that entry is a symlink or junction (an `npm link`). The bin
 * itself may be a symlink (POSIX `<prefix>/bin/ccc`): one hop is followed.
 */
export function linkedPackageEntry(scriptPath: string): string | null {
  let script = path.resolve(scriptPath);
  try {
    if (fs.lstatSync(script).isSymbolicLink()) {
      script = path.resolve(path.dirname(script), fs.readlinkSync(script));
    }
  } catch {
    return null;
  }
  for (let dir = path.dirname(script); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (path.basename(dir) !== PACKAGE_NAME || path.basename(path.dirname(dir)) !== "node_modules") {
      continue;
    }
    try {
      return fs.lstatSync(dir).isSymbolicLink() ? dir : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The first directory this user cannot write. On Windows access(W_OK) ignores
 * ACLs (C:\Program Files passes), so a file is actually created and removed.
 */
function firstUnwritable(dirs: string[], windows = false): string | null {
  for (const dir of dirs) {
    try {
      if (windows) {
        const probe = path.join(dir, `.ccc-write-probe-${process.pid}-${randomUUID()}`);
        fs.writeFileSync(probe, "");
        fs.rmSync(probe, { force: true });
      } else {
        fs.accessSync(dir, fs.constants.W_OK);
      }
    } catch {
      return dir;
    }
  }
  return null;
}

function method(kind: InstallMethodKind, packageDir: string, detail: string): InstallMethod {
  return { kind, packageDir, detail };
}

function skip(reason: string, code: SkipCode): AutoUpdateDecision {
  return { action: "skip", reason, code };
}

// ---------------------------------------------------------------------------
// Attempts, backoff and state
// ---------------------------------------------------------------------------

/** Why this version must not be tried now, or null. */
function attemptBlocked(state: UpdateState, version: string, now: number): string | null {
  if ((state.attempts[version] ?? 0) >= MAX_ATTEMPTS_PER_VERSION) {
    return `already tried ${version} ${MAX_ATTEMPTS_PER_VERSION} times`;
  }
  const last = state.last;
  if (!last) return null;
  // A run that never reported (killed, machine asleep) counts as a failure
  // once its lock would be stale.
  const failedAt =
    last.status === "failed" ? last.at
    : last.status === "running" && now - last.at > UPDATE_LOCK_STALE_MS ? last.at
    : null;
  if (failedAt !== null && now - failedAt < AUTO_UPDATE_BACKOFF_MS) {
    return "backing off for a day after a failed install";
  }
  return null;
}

/** attemptBlocked plus "the package is already at or past this version". */
function installBlockedNow(
  stateFile: string,
  packageDir: string,
  version: string,
  now: number
): string | null {
  const installed = readInstalledVersion(packageDir);
  if (installed !== null && !newerThan(version, installed)) return `${installed} is installed`;
  return attemptBlocked(readUpdateState(stateFile), version, now);
}

function recordAttemptStart(file: string, version: string, packageDir: string, now: number): void {
  const state = readUpdateState(file);
  state.attempts[version] = (state.attempts[version] ?? 0) + 1;
  state.attempts = newestAttempts(state.attempts);
  state.last = { version, status: "running", at: now, packageDir };
  writeUpdateState(file, state);
}

function spawnFailed(
  files: UpdateFiles,
  token: string,
  version: string,
  packageDir: string,
  err: unknown,
  /** The launch reports it itself (auto_update spawn-failed): not again on the next one. */
  reported = true
): void {
  const state = readUpdateState(files.stateFile);
  const error = `could not start the installer: ${String(err).slice(0, 200)}`;
  state.last = {
    version, status: "failed", at: Date.now(), packageDir, error, ...(reported ? { reported } : {}),
  };
  writeUpdateState(files.stateFile, state);
  releaseUpdateLock(files.lockDir, token);
}

function newestAttempts(attempts: Record<string, number>): Record<string, number> {
  const versions = Object.keys(attempts).sort((a, b) =>
    compareVersions(parseVersion(b)!, parseVersion(a)!)
  );
  return Object.fromEntries(versions.slice(0, VERSIONS_KEPT).map((v) => [v, attempts[v]]));
}

function cleanAttempts(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [version, count] of Object.entries(value)) {
    if (strictReleaseVersion(version) && Number.isInteger(count) && (count as number) > 0) {
      out[version] = count as number;
    }
  }
  return out;
}

function cleanAttempt(value: any): UpdateAttempt | undefined {
  if (!value || typeof value !== "object") return undefined;
  const version = strictReleaseVersion(value.version);
  const status = ["running", "ok", "failed"].includes(value.status) ? value.status : null;
  if (!version || !status || typeof value.at !== "number" || typeof value.packageDir !== "string") {
    return undefined;
  }
  const error = typeof value.error === "string" ? value.error.slice(0, 300) : undefined;
  return {
    version, status, at: value.at, packageDir: value.packageDir, ...(error ? { error } : {}),
    ...(value.reported === true ? { reported: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function runnerConfig(
  opts: StartInstallOptions,
  m: InstallMethod,
  version: string,
  token: string,
  npm: { npm: string; npmArgs?: string[] }
): RunnerConfig {
  return {
    ...npm,
    ...(opts.waitForPid !== undefined ? { waitForPid: opts.waitForPid } : {}),
    packageName: PACKAGE_NAME,
    version,
    packageDir: m.packageDir,
    npmRoot: m.npmRoot!,
    prefix: m.prefix!,
    stateFile: opts.files.stateFile,
    lockDir: opts.files.lockDir,
    logFile: opts.files.logFile,
    token,
    timeoutMs: INSTALL_TIMEOUT_MS,
  };
}

/**
 * How the runner starts npm. POSIX: the npm beside this Node (so it targets
 * the same prefix), else PATH's. Windows: this Node running npm-cli.js, found
 * beside this Node or beside an npm.cmd on PATH; null when there is none.
 */
function npmCommand(opts: StartInstallOptions): { npm: string; npmArgs?: string[] } | null {
  const execPath = opts.execPath ?? process.execPath;
  if (opts.npmPath) return { npm: opts.npmPath, ...(opts.npmArgs ? { npmArgs: opts.npmArgs } : {}) };
  if ((opts.platform ?? process.platform) !== "win32") {
    const beside = path.join(path.dirname(execPath), "npm");
    return { npm: fs.existsSync(beside) ? beside : "npm" };
  }
  const cli = windowsNpmCli(execPath, opts.env ?? process.env);
  return cli ? { npm: execPath, npmArgs: [cli] } : null;
}

function windowsNpmCli(execPath: string, env: NodeJS.ProcessEnv): string | null {
  const cliIn = (dir: string) => path.join(dir, "node_modules", "npm", "bin", "npm-cli.js");
  const pathValue = Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")?.[1] ?? "";
  const dirs = [
    path.dirname(execPath),
    ...pathValue.split(";").map((d) => d.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean),
  ];
  for (const dir of dirs) {
    if (dir !== path.dirname(execPath) && !fs.existsSync(path.join(dir, "npm.cmd"))) continue;
    if (fs.existsSync(cliIn(dir))) return cliIn(dir);
  }
  return null;
}

/** npm's `#!/usr/bin/env node` must find this same Node first. */
function runnerEnv(
  env: NodeJS.ProcessEnv,
  execPath = process.execPath,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const bin = path.dirname(execPath);
  // Windows env names are case-insensitive; a copy keeps whichever spelling it had.
  const key = platform === "win32"
    ? Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "Path"
    : "PATH";
  const delimiter = platform === "win32" ? ";" : ":";
  return {
    ...env,
    [key]: env[key] ? `${bin}${delimiter}${env[key]}` : bin,
    npm_config_update_notifier: "false",
    // The install ping (install-ping.ts) is for installs people make, not these updates.
    [AUTO_UPDATE_ENV]: "1",
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function newerThan(version: string, current: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(current);
  return a !== null && b !== null && compareVersions(a, b) > 0;
}

function envFlagSet(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function samePackageDir(a: string, b: string): boolean {
  return (realpathOrNull(a) ?? a) === (realpathOrNull(b) ?? b);
}
