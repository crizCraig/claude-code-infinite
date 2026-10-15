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
}

export const RUNNER_SOURCE = String.raw`"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const ROOT_TIMEOUT_MS = 60000;
const cfg = JSON.parse(process.argv[1]);
let logFd = null;

function note(line) {
  try {
    if (logFd !== null) fs.writeSync(logFd, "[" + new Date().toISOString() + "] " + line + "\n");
  } catch {}
}

function run(command, args, timeoutMs, capture) {
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(command, args, {
        cwd: os.homedir(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: null, error: String(err), out: "" });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
    }, timeoutMs);
    const logChunk = (chunk) => {
      try { if (logFd !== null) fs.writeSync(logFd, chunk); } catch {}
    };
    child.stdout.on("data", (chunk) => {
      if (capture && out.length < 65536) out += chunk.toString("utf8");
      logChunk(chunk);
    });
    child.stderr.on("data", logChunk);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, error: String(err), out });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, out });
    });
  });
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

(async () => {
  try { logFd = fs.openSync(cfg.logFile, "w", 0o600); } catch {}
  note("installing " + cfg.packageName + "@" + cfg.version + " into " + cfg.prefix);
  try {
    await install();
    note("installed " + cfg.version);
    record("ok");
  } catch (err) {
    note("failed: " + (err && err.message ? err.message : String(err)));
    record("failed", err && err.message ? err.message : String(err));
  } finally {
    releaseLock();
    try { if (logFd !== null) fs.closeSync(logFd); } catch {}
  }
})();
`;
