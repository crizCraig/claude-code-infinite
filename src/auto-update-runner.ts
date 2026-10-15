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
  /** Test-only: SIGTERM→SIGKILL and SIGKILL→give-up waits (default 10 s, 5 s). */
  killGraceMs?: number;
  pipeGraceMs?: number;
}

export const RUNNER_SOURCE = String.raw`"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const ROOT_TIMEOUT_MS = 60000;
const cfg = JSON.parse(process.argv[1]);
const KILL_GRACE_MS = cfg.killGraceMs || 10000;
const PIPE_GRACE_MS = cfg.pipeGraceMs || 5000;
const ENTRY = path.join(cfg.lockDir, cfg.token + ".json");
let logFd = null;
let group = null;
let done = false;

// Hard deadline: whatever npm does, this process kills its group, records a
// result and exits, so a live holder never outlasts the lock's stale age.
const DEADLINE_MS = ROOT_TIMEOUT_MS + cfg.timeoutMs + 2 * (2 * KILL_GRACE_MS + 2 * PIPE_GRACE_MS) + 30000;
setTimeout(() => abort("runner deadline passed"), DEADLINE_MS);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => abort("runner stopped by " + signal));
}

function note(line) {
  try {
    if (logFd !== null) fs.writeSync(logFd, "[" + new Date().toISOString() + "] " + line + "\n");
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function signalGroup(pgid, signal) {
  try { process.kill(-pgid, signal); } catch {}
}

async function goneWithin(pgid, ms) {
  const until = Date.now() + ms;
  while (groupAlive(pgid)) {
    if (Date.now() >= until) return false;
    await sleep(100);
  }
  return true;
}

// Every member of the command's group, not only npm: SIGTERM, then SIGKILL.
async function reapGroup(pgid) {
  if (!groupAlive(pgid)) return true;
  signalGroup(pgid, "SIGTERM");
  if (await goneWithin(pgid, KILL_GRACE_MS)) return true;
  signalGroup(pgid, "SIGKILL");
  return goneWithin(pgid, PIPE_GRACE_MS);
}

// The lock entry names the group while it may be alive (update-lock.ts).
function recordGroup(pgid) {
  try {
    const entry = JSON.parse(fs.readFileSync(ENTRY, "utf8"));
    if (!entry || entry.token !== cfg.token) return;
    entry.pid = process.pid;
    if (pgid === null) delete entry.group; else entry.group = pgid;
    const tmp = path.join(cfg.lockDir, "." + cfg.token + "." + process.pid + ".tmp");
    fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
    fs.renameSync(tmp, ENTRY);
  } catch {}
}

// Resolves when the command is over: it closed, it exited (its pipes are not
// waited on for long), or it timed out. The caller then reaps its group.
function run(command, args, timeoutMs, capture) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    let child;
    const timers = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      resolve(Object.assign({ out, pgid: child ? child.pid : null }, result));
    };
    try {
      child = spawn(command, args, {
        cwd: os.homedir(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      finish({ code: null, error: String(err) });
      return;
    }
    if (child.pid) {
      group = child.pid;
      recordGroup(group);
    }
    timers.push(setTimeout(() => finish({ code: null, timedOut: true }), timeoutMs));
    const logChunk = (chunk) => {
      try { if (logFd !== null) fs.writeSync(logFd, chunk); } catch {}
    };
    child.stdout.on("data", (chunk) => {
      if (capture && out.length < 65536) out += chunk.toString("utf8");
      logChunk(chunk);
    });
    child.stderr.on("data", logChunk);
    child.on("error", (err) => finish({ code: null, error: String(err) }));
    child.on("exit", (code, signal) => {
      timers.push(setTimeout(() => finish({ code, signal }), PIPE_GRACE_MS));
    });
    child.on("close", (code, signal) => finish({ code, signal }));
  });
}

// Run a command and make sure nothing it started is left running.
async function runReaped(command, args, timeoutMs, capture) {
  const result = await run(command, args, timeoutMs, capture);
  if (result.pgid) {
    if (!(await reapGroup(result.pgid))) {
      const err = new Error("could not stop npm's processes (group " + result.pgid + ")");
      err.groupAlive = true;
      throw err;
    }
    group = null;
    recordGroup(null);
  }
  return result;
}

function realpath(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

function describe(result, what) {
  if (result.error) return what + " could not run: " + result.error;
  if (result.timedOut) return what + " timed out";
  if (result.code !== 0) return what + " exited with " + (result.code === null ? result.signal : result.code);
  return null;
}

async function install() {
  if (!VERSION_RE.test(cfg.version)) throw new Error("refusing version " + JSON.stringify(cfg.version));
  const rootRun = await runReaped(cfg.npm, ["root", "--global"], ROOT_TIMEOUT_MS, true);
  const rootFailure = describe(rootRun, "npm root -g");
  if (rootFailure) throw new Error(rootFailure);
  const npmRoot = realpath(rootRun.out.trim());
  if (npmRoot === null || npmRoot !== realpath(cfg.npmRoot)) {
    throw new Error("npm root -g is " + rootRun.out.trim() + ", not " + cfg.npmRoot + ": wrong prefix");
  }
  const entry = path.join(npmRoot, cfg.packageName);
  if (fs.lstatSync(entry).isSymbolicLink()) throw new Error(entry + " is a symlink (npm link)");
  if (realpath(entry) !== realpath(cfg.packageDir)) throw new Error(entry + " is not this ccc");
  const spec = cfg.packageName + "@" + cfg.version;
  const args = ["install", "--global", "--prefix=" + cfg.prefix, spec, "--no-fund", "--no-audit"];
  note("npm " + args.join(" "));
  const failure = describe(await runReaped(cfg.npm, args, cfg.timeoutMs, false), "npm install");
  if (failure) throw new Error(failure);
  const pkg = JSON.parse(fs.readFileSync(path.join(cfg.packageDir, "package.json"), "utf8"));
  if (pkg.version !== cfg.version) throw new Error("installed version is " + pkg.version);
}

function record(status, error) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(cfg.stateFile, "utf8")) || {}; } catch {}
  state.last = { version: cfg.version, status, at: Date.now(), packageDir: cfg.packageDir };
  if (error) state.last.error = String(error).slice(0, 300);
  const tmp = cfg.stateFile + "." + process.pid + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, cfg.stateFile);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

// Record, release the lock unless npm's group may still be alive (its entry
// then stays live exactly as long as the group: update-lock.ts), and exit.
function finishRun(status, error) {
  if (done) return;
  done = true;
  note(status === "ok" ? "installed " + cfg.version : "failed: " + error);
  record(status, error);
  if (group === null || !groupAlive(group)) {
    try { fs.rmSync(ENTRY, { force: true }); } catch {}
  } else {
    note("npm's processes are still exiting; the lock stays held until they are gone");
  }
  try { if (logFd !== null) fs.closeSync(logFd); } catch {}
  process.exit(status === "ok" ? 0 : 1);
}

async function abort(reason) {
  if (done) return;
  if (group !== null) {
    signalGroup(group, "SIGKILL");
    await goneWithin(group, 2000);
  }
  finishRun("failed", reason);
}

(async () => {
  recordGroup(null); // the lock's holder is this runner from now on
  try { logFd = fs.openSync(cfg.logFile, "w", 0o600); } catch {}
  note("installing " + cfg.packageName + "@" + cfg.version + " into " + cfg.prefix);
  try {
    await install();
    finishRun("ok");
  } catch (err) {
    finishRun("failed", err && err.message ? err.message : String(err));
  }
})();
`;
