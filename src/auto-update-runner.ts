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
 * Windows (waitForPid): the runner first waits for the ccc that started it to
 * exit, so npm does not rewrite files under that session; npm
 * runs as `node npm-cli.js` (npmArgs), and its "group" is npm's own pid,
 * stopped with `taskkill /T /F` (its whole process tree) instead of signals
 * to a POSIX process group. Unlike a POSIX group, a descendant that outlives
 * npm is not tracked there (ccc and its dependency have no install scripts).
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
  /** Arguments before npm's own: Windows runs `node npm-cli.js`. */
  npmArgs?: string[];
  /** Windows: wait for this pid (the launching ccc) to exit before installing. */
  waitForPid?: number;
  /** Test-only: how long to wait for waitForPid (default 60 s). */
  waitForPidMs?: number;
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

export const RUNNER_SOURCE = String.raw`"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const ROOT_TIMEOUT_MS = 60000;
const IS_WINDOWS = process.platform === "win32";
const cfg = JSON.parse(process.argv[1]);
const WAIT_FOR_PID_MS = cfg.waitForPidMs || 60000;
const KILL_GRACE_MS = cfg.killGraceMs || 10000;
const PIPE_GRACE_MS = cfg.pipeGraceMs || 5000;
const ENTRY = path.join(cfg.lockDir, cfg.token + ".json");
const HANDOFF_MS = cfg.handoffMs || 10000;
let logFd = null;
let group = null;
let done = false;
// Set first thing on abort or a lost lock: no command starts after it.
let stopping = null;

// Hard deadline: whatever npm does, this process kills its group, records a
// result and exits, so a live holder never outlasts the lock's stale age.
const DEADLINE_MS = ROOT_TIMEOUT_MS + cfg.timeoutMs + 2 * (2 * KILL_GRACE_MS + 2 * PIPE_GRACE_MS) +
  (cfg.waitForPid ? WAIT_FOR_PID_MS : 0) + 30000;
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

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Windows has no process groups: the "group" is npm's pid and its tree.
function groupAlive(pgid) {
  return pidAlive(IS_WINDOWS ? pgid : -pgid);
}

function signalGroup(pgid, signal) {
  if (IS_WINDOWS) {
    try {
      const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
      require("node:child_process").spawnSync(taskkill, ["/PID", String(pgid), "/T", "/F"], {
        stdio: "ignore", windowsHide: true, timeout: 10000,
      });
    } catch {}
    return;
  }
  try { process.kill(-pgid, signal); } catch {}
}

async function awaitLauncherExit() {
  if (!cfg.waitForPid) return true;
  const until = Date.now() + WAIT_FOR_PID_MS;
  while (pidAlive(cfg.waitForPid)) {
    if (Date.now() >= until || stopping) return false;
    await sleep(100);
  }
  return true;
}

function npmArgs(args) {
  return (cfg.npmArgs || []).concat(args);
}

function samePath(a, b) {
  return a !== null && b !== null && (IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b);
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
// "spawning" is set before every npm spawn and cleared only once its group is
// recorded: if this runner dies in between, the entry stays live (fail
// closed) because an unrecorded npm may be running (update-lock.ts).
function recordGroup(pgid, spawning) {
  const entry = readEntry();
  if (!entry) {
    stopping = stopping || "lost the install lock";
    if (pgid !== null) signalGroup(pgid, "SIGKILL"); // started without the lock: stop it
    return false;
  }
  try {
    entry.pid = process.pid;
    entry.runner = process.pid;
    if (pgid === null) delete entry.group; else entry.group = pgid;
    if (spawning) entry.spawning = true; else delete entry.spawning;
    const tmp = path.join(cfg.lockDir, "." + cfg.token + "." + process.pid + ".tmp");
    fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
    fs.renameSync(tmp, ENTRY);
    return true;
  } catch {
    return false;
  }
}

function readEntry() {
  try {
    const entry = JSON.parse(fs.readFileSync(ENTRY, "utf8"));
    return entry && entry.token === cfg.token ? entry : null;
  } catch {
    return null;
  }
}

// The launcher records this runner's pid in the entry right after spawning
// it; until then the entry is not provably ours. Gone means another session
// took the lock: leave everything to it.
async function awaitHandoff() {
  const until = Date.now() + HANDOFF_MS;
  for (;;) {
    const entry = readEntry();
    if (!entry) return "lost";
    if (entry.runner === process.pid) return "ok";
    if (Date.now() >= until) return "timeout";
    await sleep(50);
  }
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
    if (stopping || !recordGroup(null, true)) {
      finish({ code: null, error: stopping || "lost the install lock" });
      return;
    }
    try {
      child = spawn(command, args, {
        cwd: os.homedir(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        windowsHide: true,
      });
    } catch (err) {
      recordGroup(null, false);
      finish({ code: null, error: String(err) });
      return;
    }
    if (child.pid) {
      group = child.pid;
      recordGroup(group, false);
    } else {
      recordGroup(null, false); // spawn failed; its 'error' event follows
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
    recordGroup(null, false);
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
  if (!(await awaitLauncherExit())) throw new Error(stopping || "ccc did not exit");
  const rootRun = await runReaped(cfg.npm, npmArgs(["root", "--global"]), ROOT_TIMEOUT_MS, true);
  const rootFailure = describe(rootRun, "npm root -g");
  if (rootFailure) throw new Error(rootFailure);
  const npmRoot = realpath(rootRun.out.trim());
  if (npmRoot === null || !samePath(npmRoot, realpath(cfg.npmRoot))) {
    throw new Error("npm root -g is " + rootRun.out.trim() + ", not " + cfg.npmRoot + ": wrong prefix");
  }
  const entry = path.join(npmRoot, cfg.packageName);
  if (fs.lstatSync(entry).isSymbolicLink()) throw new Error(entry + " is a symlink (npm link)");
  if (!samePath(realpath(entry), realpath(cfg.packageDir))) throw new Error(entry + " is not this ccc");
  const spec = cfg.packageName + "@" + cfg.version;
  const args = ["install", "--global", "--prefix=" + cfg.prefix, spec, "--no-fund", "--no-audit"];
  note("npm " + args.join(" "));
  const failure = describe(await runReaped(cfg.npm, npmArgs(args), cfg.timeoutMs, false), "npm install");
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
  // Without the lock the state belongs to whoever holds it now.
  if (readEntry()) record(status, error);
  if (group === null || !groupAlive(group)) {
    try { fs.rmSync(ENTRY, { force: true }); } catch {}
  } else {
    note("npm's processes are still exiting; the lock stays held until they are gone");
  }
  try { if (logFd !== null) fs.closeSync(logFd); } catch {}
  process.exit(status === "ok" ? 0 : 1);
}

async function abort(reason) {
  if (done || stopping) return;
  stopping = reason;
  if (group !== null) {
    signalGroup(group, "SIGKILL");
    await goneWithin(group, 2000);
  }
  finishRun("failed", reason);
}

(async () => {
  const handoff = await awaitHandoff();
  if (handoff === "lost") process.exit(1); // not ours: record nothing, touch nothing
  if (handoff === "timeout") {
    stopping = "the launcher never handed over the install lock";
    finishRun("failed", stopping);
    return;
  }
  recordGroup(null, false); // the lock's holder is this runner from now on
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
