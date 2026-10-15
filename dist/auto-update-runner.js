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
export const RUNNER_SOURCE = String.raw `"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const ROOT_TIMEOUT_MS = 60000;
const cfg = JSON.parse(process.argv[1]);
const KILL_GRACE_MS = cfg.killGraceMs || 10000;
const PIPE_GRACE_MS = cfg.pipeGraceMs || 5000;
let logFd = null;
let current = null;
let done = false;

// Hard deadline: whatever npm does, this process records a result, frees the
// lock and exits, so a live holder never outlasts the lock's stale age.
const DEADLINE_MS = ROOT_TIMEOUT_MS + cfg.timeoutMs + 2 * (KILL_GRACE_MS + PIPE_GRACE_MS) + 30000;
setTimeout(() => abort("runner deadline passed"), DEADLINE_MS);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => abort("runner stopped by " + signal));
}

function abort(reason) {
  if (current) killGroup(current, "SIGKILL");
  finishRun("failed", reason);
}

function note(line) {
  try {
    if (logFd !== null) fs.writeSync(logFd, "[" + new Date().toISOString() + "] " + line + "\n");
  } catch {}
}

// npm runs in its own process group, so a timeout reaches everything it
// started: SIGTERM, then SIGKILL, then give up waiting on its pipes.
function run(command, args, timeoutMs, capture) {
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    let settled = false;
    let child;
    const timers = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      current = null;
      timers.forEach(clearTimeout);
      resolve(Object.assign({ timedOut, out }, result));
    };
    try {
      child = spawn(command, args, {
        cwd: os.homedir(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      resolve({ code: null, error: String(err), out: "" });
      return;
    }
    current = child;
    timers.push(setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      timers.push(setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS));
      timers.push(setTimeout(() => finish({ code: null, signal: "SIGKILL" }), KILL_GRACE_MS + PIPE_GRACE_MS));
    }, timeoutMs));
    const logChunk = (chunk) => {
      try { if (logFd !== null) fs.writeSync(logFd, chunk); } catch {}
    };
    child.stdout.on("data", (chunk) => {
      if (capture && out.length < 65536) out += chunk.toString("utf8");
      logChunk(chunk);
    });
    child.stderr.on("data", logChunk);
    child.on("error", (err) => finish({ code: null, error: String(err) }));
    // A descendant holding the pipes open must not keep us waiting for close.
    child.on("exit", (code, signal) => {
      timers.push(setTimeout(() => finish({ code, signal }), PIPE_GRACE_MS));
    });
    child.on("close", (code, signal) => finish({ code, signal }));
  });
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
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
  const rootRun = await run(cfg.npm, ["root", "--global"], ROOT_TIMEOUT_MS, true);
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
  const failure = describe(await run(cfg.npm, args, cfg.timeoutMs, false), "npm install");
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

function releaseLock() {
  try {
    const held = JSON.parse(fs.readFileSync(cfg.lockFile, "utf8"));
    if (held && held.token === cfg.token) fs.rmSync(cfg.lockFile, { force: true });
  } catch {}
}

function finishRun(status, error) {
  if (done) return;
  done = true;
  note(status === "ok" ? "installed " + cfg.version : "failed: " + error);
  record(status, error);
  releaseLock();
  try { if (logFd !== null) fs.closeSync(logFd); } catch {}
  process.exit(status === "ok" ? 0 : 1);
}

(async () => {
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
//# sourceMappingURL=auto-update-runner.js.map