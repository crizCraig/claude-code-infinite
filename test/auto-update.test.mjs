import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  AUTO_UPDATE_BACKOFF_MS,
  AutoUpdateNotices,
  UPDATE_LOCK_STALE_MS,
  acquireUpdateLock,
  autoUpdateEnabled,
  detectInstallMethod,
  planAutoUpdate,
  readUpdateState,
  releaseUpdateLock,
  startAutoUpdateInstall,
  strictReleaseVersion,
  updateFiles,
  writeUpdateState,
} from "../dist/auto-update.js";
import { RUNNER_SOURCE } from "../dist/auto-update-runner.js";
import { setupAutoUpdate } from "../dist/auto-update-setup.js";
import { UPGRADE_COMMAND } from "../dist/update-check.js";

const PKG = "claude-code-infinite";
const UPDATE = { latest: "1.0.21", current: "1.0.20" };
const isRoot = process.getuid?.() === 0;

function tmpdir(label = "ccc-au-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), label)));
}

/** A package directory at `dir` (dist/ and package.json at `version`). */
function makePackage(dir, version = "1.0.20") {
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: PKG, version }));
  return dir;
}

/** `<prefix>/lib/node_modules/claude-code-infinite` plus `<prefix>/bin`. */
function makeGlobal(root = tmpdir(), version = "1.0.20") {
  const prefix = path.join(root, "prefix");
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
  const npmRoot = path.join(prefix, "lib", "node_modules");
  const packageDir = makePackage(path.join(npmRoot, PKG), version);
  return { root, prefix, npmRoot, packageDir };
}

function detect(packageDir, extra = {}) {
  return detectInstallMethod({ packageDir, platform: "darwin", uid: 501, env: {}, ...extra });
}

function plan(overrides = {}) {
  const g = overrides.global ?? makeGlobal();
  return planAutoUpdate({
    update: UPDATE,
    method: detect(g.packageDir),
    state: { attempts: {} },
    env: {},
    config: {},
    now: 1_000_000_000,
    installedVersion: "1.0.20",
    ...overrides,
  });
}

/** A child_process.spawn stand-in that records calls; never runs anything. */
function mockSpawn({ pid = 4242, throws, emitError } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    if (throws) throw throws;
    const listeners = {};
    const child = {
      pid,
      unrefCalled: false,
      unref() { child.unrefCalled = true; },
      on(event, cb) { listeners[event] = cb; return child; },
    };
    if (emitError) queueMicrotask(() => listeners.error?.(emitError));
    calls.at(-1).child = child;
    return child;
  };
  return { spawnImpl, calls };
}

function filesIn(dir = tmpdir("ccc-au-cfg-")) {
  return updateFiles(dir);
}

// ---------------------------------------------------------------------------
// Install-method detection
// ---------------------------------------------------------------------------

test("a plain global npm install, writable without sudo, self-updates", () => {
  const g = makeGlobal();
  const m = detect(g.packageDir);
  assert.equal(m.kind, "npm-global");
  assert.equal(m.npmRoot, g.npmRoot);
  assert.equal(m.prefix, g.prefix);
  assert.equal(m.packageDir, g.packageDir);
});

test("npm-linked installs are never self-updated, with or without .git", () => {
  const root = tmpdir();
  const g = makeGlobal(root);
  fs.rmSync(g.packageDir, { recursive: true });
  // `npm link` from a checkout: the global entry is a symlink to it.
  const checkout = makePackage(path.join(root, "src", PKG));
  fs.symlinkSync(checkout, g.packageDir);
  assert.equal(detect(g.packageDir).kind, "npm-link");
  // Craig's setup: the linked checkout is a git repo.
  fs.mkdirSync(path.join(checkout, ".git"));
  const m = detect(g.packageDir);
  assert.equal(m.kind, "git-checkout");
  assert.equal(m.packageDir, checkout, "resolved through the link");
  // A worktree's .git is a file.
  fs.rmSync(path.join(checkout, ".git"), { recursive: true });
  fs.writeFileSync(path.join(checkout, ".git"), "gitdir: elsewhere");
  assert.equal(detect(g.packageDir).kind, "git-checkout");
});

test("a git checkout run directly is never self-updated", () => {
  const dir = makePackage(path.join(tmpdir(), "lib", "node_modules", PKG));
  fs.mkdirSync(path.join(dir, ".git"));
  assert.equal(detect(dir).kind, "git-checkout");
});

test("npx and project-local installs are skipped", () => {
  const npx = makePackage(path.join(tmpdir(), ".npm", "_npx", "abc123", "node_modules", PKG));
  assert.equal(detect(npx).kind, "npx");
  const local = makePackage(path.join(tmpdir(), "project", "node_modules", PKG));
  assert.equal(detect(local).kind, "local");
});

test("pnpm, yarn, bun and volta global installs are skipped", () => {
  const root = tmpdir();
  const cases = {
    pnpm: path.join(root, "Library", "pnpm", "global", "5", "node_modules", ".pnpm", `${PKG}@1.0.20`, "node_modules", PKG),
    yarn: path.join(root, ".config", "yarn", "global", "node_modules", PKG),
    bun: path.join(root, ".bun", "install", "global", "node_modules", PKG),
    volta: path.join(root, ".volta", "tools", "image", "packages", PKG, "lib", "node_modules", PKG),
  };
  for (const [kind, dir] of Object.entries(cases)) {
    assert.equal(detect(makePackage(dir)).kind, kind, kind);
  }
  // Volta with a custom VOLTA_HOME.
  const voltaHome = path.join(root, "custom-volta");
  const dir = makePackage(path.join(voltaHome, "tools", "image", "packages", PKG, "lib", "node_modules", PKG));
  assert.equal(detect(dir, { env: { VOLTA_HOME: voltaHome } }).kind, "volta");
});

test("a prefix that needs sudo is skipped, never escalated", { skip: isRoot && "root can write anything" }, () => {
  for (const which of ["npmRoot", "bin", "packageDir"]) {
    const g = makeGlobal();
    const dir = which === "bin" ? path.join(g.prefix, "bin") : g[which];
    fs.chmodSync(dir, 0o555);
    try {
      const m = detect(g.packageDir);
      assert.equal(m.kind, "not-writable", which);
      assert.match(m.detail, /not writable without sudo/);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  }
});

test("root, sudo and Windows are skipped", () => {
  const g = makeGlobal();
  assert.equal(detect(g.packageDir, { uid: 0 }).kind, "root");
  assert.equal(detect(g.packageDir, { env: { SUDO_UID: "501" } }).kind, "root");
  assert.equal(detect(g.packageDir, { platform: "win32" }).kind, "unsupported-platform");
  assert.equal(detect(path.join(g.root, "missing")).kind, "unknown");
});

// ---------------------------------------------------------------------------
// Opt-outs and strict versions
// ---------------------------------------------------------------------------

test("opt-outs: CCC_DISABLE_AUTOUPDATE, DISABLE_AUTOUPDATER, autoUpdate:false, and the update-check ones", () => {
  assert.equal(autoUpdateEnabled({}, {}), true);
  for (const env of [
    { CCC_DISABLE_AUTOUPDATE: "1" },
    { CCC_DISABLE_AUTOUPDATE: "true" },
    { DISABLE_AUTOUPDATER: "1" },
    { DISABLE_AUTOUPDATER: "yes" },
    { CCC_NO_UPDATE_CHECK: "1" },
    { CCC_SKIP_UPDATE_CHECK: "1" },
  ]) {
    assert.equal(autoUpdateEnabled(env, {}), false, JSON.stringify(env));
    assert.deepEqual(plan({ env }), { action: "skip", reason: "disabled" });
  }
  assert.equal(autoUpdateEnabled({ DISABLE_AUTOUPDATER: "0" }, {}), true);
  for (const config of [{ autoUpdate: false }, { updateCheck: false }]) {
    assert.equal(autoUpdateEnabled({}, config), false);
    assert.deepEqual(plan({ config }), { action: "skip", reason: "disabled" });
  }
});

test("only a strict release version ever reaches npm", () => {
  assert.equal(strictReleaseVersion("1.0.21"), "1.0.21");
  const hostile = [
    "1.0.21; rm -rf ~", "1.0.21 --prefix=/", "$(id)", "1.0.21-beta.1", "v1.0.21",
    "01.0.21", "1.0", "latest", "1.0.21\n", " 1.0.21", "1.0.21+build", "1.0.21 && x",
  ];
  for (const version of hostile) {
    assert.equal(strictReleaseVersion(version), null, JSON.stringify(version));
    const decision = plan({ update: { latest: version, current: "1.0.20" } });
    assert.equal(decision.action, "skip", JSON.stringify(version));
    const { spawnImpl, calls } = mockSpawn();
    const forged = { action: "install", version, method: detect(makeGlobal().packageDir) };
    assert.equal(startAutoUpdateInstall({ decision: forged, files: filesIn(), spawnImpl }), "not-planned");
    assert.equal(calls.length, 0);
  }
});

// ---------------------------------------------------------------------------
// Planning: backoff, attempt limit, already installed
// ---------------------------------------------------------------------------

test("a failure backs off for a day; a version is tried at most twice", () => {
  const now = 10 * AUTO_UPDATE_BACKOFF_MS;
  const g = makeGlobal();
  const failed = (at) => ({
    attempts: { "1.0.21": 1 },
    last: { version: "1.0.21", status: "failed", at, packageDir: g.packageDir },
  });
  assert.equal(plan({ global: g, now, state: failed(now - 60_000) }).action, "skip");
  assert.match(plan({ global: g, now, state: failed(now - 60_000) }).reason, /backing off/);
  assert.equal(plan({ global: g, now, state: failed(now - AUTO_UPDATE_BACKOFF_MS - 1) }).action, "install");
  const twice = { ...failed(now - 2 * AUTO_UPDATE_BACKOFF_MS), attempts: { "1.0.21": 2 } };
  assert.match(plan({ global: g, now, state: twice }).reason, /already tried 1\.0\.21 2 times/);
  // A newer release starts a fresh count.
  assert.equal(
    plan({ global: g, now, state: twice, update: { latest: "1.0.22", current: "1.0.20" } }).action,
    "install"
  );
  // A run that never reported counts as failed once its lock would be stale.
  const running = (at) => ({ attempts: { "1.0.21": 1 }, last: { ...failed(at).last, status: "running" } });
  assert.equal(plan({ global: g, now, state: running(now - UPDATE_LOCK_STALE_MS - 1) }).action, "skip");
  assert.equal(plan({ global: g, now, state: running(now - 1000) }).action, "install");
});

test("an install that already landed is reported, not repeated", () => {
  assert.deepEqual(plan({ installedVersion: "1.0.21" }), { action: "installed", version: "1.0.21" });
});

test("linked installs plan no install, and a forged plan never spawns", () => {
  const root = tmpdir();
  const g = makeGlobal(root);
  fs.rmSync(g.packageDir, { recursive: true });
  const checkout = makePackage(path.join(root, "src", PKG));
  fs.mkdirSync(path.join(checkout, ".git"));
  fs.symlinkSync(checkout, g.packageDir);
  const method = detect(g.packageDir);
  const decision = plan({ method });
  assert.deepEqual(decision, { action: "skip", reason: "install method git-checkout" });
  const { spawnImpl, calls } = mockSpawn();
  const files = filesIn();
  assert.equal(startAutoUpdateInstall({ decision, files, spawnImpl }), "not-planned");
  const forged = { action: "install", version: "1.0.21", method };
  assert.equal(startAutoUpdateInstall({ decision: forged, files, spawnImpl }), "not-planned");
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(files.lockFile), false);
});

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

test("the lock admits one installer; only its token releases it", () => {
  const { lockFile } = filesIn();
  const now = Date.now();
  const token = acquireUpdateLock(lockFile, now);
  assert.ok(token);
  assert.equal(acquireUpdateLock(lockFile, now + 1000), null, "held by a live session");
  releaseUpdateLock(lockFile, "someone-else");
  assert.ok(fs.existsSync(lockFile));
  releaseUpdateLock(lockFile, token);
  assert.equal(fs.existsSync(lockFile), false);
  assert.ok(acquireUpdateLock(lockFile, now));
});

test("a stale lock is taken over: too old, or its holder has exited", () => {
  const { lockFile } = filesIn();
  const now = Date.now();
  const write = (data) => fs.writeFileSync(lockFile, JSON.stringify(data));
  write({ token: "old", startedAt: now - UPDATE_LOCK_STALE_MS - 1, pid: process.pid });
  assert.ok(acquireUpdateLock(lockFile, now), "older than the stale timeout");

  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  write({ token: "dead", startedAt: now - 60_000, pid: dead });
  assert.ok(acquireUpdateLock(lockFile, now), "holder exited");

  write({ token: "young", startedAt: now - 5_000, pid: dead });
  assert.equal(acquireUpdateLock(lockFile, now), null, "a just-started holder gets a grace period");
  write({ token: "live", startedAt: now - 60_000, pid: process.pid });
  assert.equal(acquireUpdateLock(lockFile, now), null, "live holder keeps it");
});

test("an unreadable lock is left alone while fresh (being written), taken when old", () => {
  const { lockFile } = filesIn();
  const now = Date.now();
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, "");
  assert.equal(acquireUpdateLock(lockFile, now), null);
  const old = new Date(now - 120_000);
  fs.utimesSync(lockFile, old, old);
  assert.ok(acquireUpdateLock(lockFile, now));
});

// ---------------------------------------------------------------------------
// Starting the install (child_process mocked)
// ---------------------------------------------------------------------------

test("start: one detached runner via node -e, counted, holding the lock", () => {
  const g = makeGlobal();
  const files = filesIn();
  const decision = plan({ global: g });
  assert.equal(decision.action, "install");
  const { spawnImpl, calls } = mockSpawn({ pid: 777 });
  const result = startAutoUpdateInstall({
    decision, files, spawnImpl, env: { PATH: "/usr/bin" },
    execPath: "/opt/node/bin/node", npmPath: "/opt/node/bin/npm",
  });
  assert.equal(result, "started");
  assert.equal(calls.length, 1);
  const [{ command, args, options, child }] = calls;
  assert.equal(command, "/opt/node/bin/node");
  assert.equal(args[0], "-e");
  assert.equal(args[1], RUNNER_SOURCE);
  const config = JSON.parse(args[2]);
  assert.equal(config.version, "1.0.21");
  assert.equal(config.npm, "/opt/node/bin/npm");
  assert.equal(config.prefix, g.prefix);
  assert.equal(config.npmRoot, g.npmRoot);
  assert.equal(config.packageDir, g.packageDir);
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.env.PATH, `/opt/node/bin${path.delimiter}/usr/bin`, "npm's shebang finds this Node");
  assert.ok(child.unrefCalled, "never keeps ccc alive");
  const state = readUpdateState(files.stateFile);
  assert.deepEqual(state.attempts, { "1.0.21": 1 });
  assert.equal(state.last.status, "running");
  const lock = JSON.parse(fs.readFileSync(files.lockFile, "utf8"));
  assert.equal(lock.pid, 777, "the runner, not this session, holds the lock");
  assert.equal(lock.token, config.token);

  // A second session meanwhile: locked, nothing spawned.
  const second = mockSpawn();
  assert.equal(startAutoUpdateInstall({ decision, files, spawnImpl: second.spawnImpl }), "locked");
  assert.equal(second.calls.length, 0);
});

test("a runner that cannot start is a recorded failure and frees the lock", async () => {
  const decision = plan();
  for (const mode of ["throws", "emitError"]) {
    const files = filesIn();
    const { spawnImpl } = mockSpawn({ [mode]: new Error("ENOENT node") });
    const result = startAutoUpdateInstall({ decision, files, spawnImpl });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result, mode === "throws" ? "spawn-failed" : "started");
    const last = readUpdateState(files.stateFile).last;
    assert.equal(last.status, "failed", mode);
    assert.match(last.error, /could not start the installer/);
    assert.equal(fs.existsSync(files.lockFile), false, mode);
  }
});

// ---------------------------------------------------------------------------
// Session notices
// ---------------------------------------------------------------------------

function notices(stateFile, packageDir, extra = {}) {
  return new AutoUpdateNotices({
    currentVersion: "1.0.20",
    packageDir,
    stateFile,
    startedAt: 1000,
    installedText: (v) => `✔ ccc ${v} installed · restart ccc to use it`,
    hintText: (u) => `• ccc ${u.latest} is available (you have ${u.current}) · ${UPGRADE_COMMAND}`,
    ...extra,
  });
}

test("success: the next SessionStart says installed, once per session", () => {
  const g = makeGlobal(undefined, "1.0.21");
  const { stateFile } = filesIn();
  const n = notices(stateFile, g.packageDir);
  assert.equal(n.sessionStartLine(), undefined, "nothing recorded yet");
  writeUpdateState(stateFile, {
    attempts: { "1.0.21": 1 },
    last: { version: "1.0.21", status: "running", at: 2000, packageDir: g.packageDir },
  });
  assert.equal(n.sessionStartLine(), undefined, "still installing");
  writeUpdateState(stateFile, {
    attempts: { "1.0.21": 1 },
    last: { version: "1.0.21", status: "ok", at: 3000, packageDir: g.packageDir },
  });
  assert.equal(n.sessionStartLine(), "✔ ccc 1.0.21 installed · restart ccc to use it");
  assert.equal(n.sessionStartLine(), undefined, "once");

  // Not when the files on disk say otherwise, nor for another ccc install.
  const other = makeGlobal(undefined, "1.0.20");
  assert.equal(notices(stateFile, other.packageDir).sessionStartLine(), undefined);
  assert.equal(
    notices(stateFile, g.packageDir, { readInstalledVersion: () => "1.0.22" }).sessionStartLine(),
    undefined
  );
  // A session already on that version has nothing to restart for.
  assert.equal(notices(stateFile, g.packageDir, { currentVersion: "1.0.21" }).sessionStartLine(), undefined);
});

test("failure: the hint with the manual command, once, only for this session's attempt", () => {
  const g = makeGlobal();
  const { stateFile } = filesIn();
  const failed = (at) => ({
    attempts: { "1.0.21": 1 },
    last: { version: "1.0.21", status: "failed", at, packageDir: g.packageDir, error: "npm install exited with 1" },
  });
  writeUpdateState(stateFile, failed(500));
  assert.equal(notices(stateFile, g.packageDir).sessionStartLine(), undefined, "before this session: banner had it");
  writeUpdateState(stateFile, failed(2000));
  const n = notices(stateFile, g.packageDir);
  assert.equal(
    n.sessionStartLine(),
    `• ccc 1.0.21 is available (you have 1.0.20) · ${UPGRADE_COMMAND}`
  );
  assert.equal(n.sessionStartLine(), undefined);
});

// ---------------------------------------------------------------------------
// Launch setup (banner + schedule)
// ---------------------------------------------------------------------------

function setup(packageDir, extra = {}) {
  return setupAutoUpdate({
    update: UPDATE,
    currentVersion: "1.0.20",
    config: {},
    configDir: tmpdir("ccc-au-cfg-"),
    color: false,
    env: {},
    packageDir,
    platform: "darwin",
    uid: 501,
    ...extra,
  });
}

test("setup: an install hides the hint; a skip shows it; a landed install shows installed", async () => {
  const g = makeGlobal();
  const { spawnImpl, calls } = mockSpawn();
  const s = setup(g.packageDir, { spawnImpl });
  assert.equal(s.decision.action, "install");
  assert.equal(s.bannerUpdate, null);
  assert.equal(s.bannerInstalled, null);
  assert.match(s.debugLine, /install method npm-global .*installing 1\.0\.21 in the background/);
  const result = await new Promise((resolve) => s.scheduleInstall(0, resolve));
  assert.equal(result, "started");
  assert.equal(calls.length, 1);

  const off = setup(g.packageDir, { env: { CCC_DISABLE_AUTOUPDATE: "1" } });
  assert.deepEqual(off.bannerUpdate, UPDATE, "opted out: today's hint");

  const npx = makePackage(path.join(tmpdir(), "_npx", "a", "node_modules", PKG));
  const skipped = setup(npx, { spawnImpl });
  assert.deepEqual(skipped.bannerUpdate, UPDATE);
  assert.match(skipped.debugLine, /install method npx/);
  skipped.scheduleInstall(0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 1, "no spawn for npx");

  const landed = setup(makeGlobal(undefined, "1.0.21").packageDir);
  assert.equal(landed.bannerInstalled, "1.0.21");
  assert.equal(landed.notices.sessionStartLine(), undefined, "the banner already said it");

  const none = setup(g.packageDir, { update: null });
  assert.equal(none.method, null);
  assert.equal(none.bannerUpdate, null);
});

// ---------------------------------------------------------------------------
// The runner, against a fake npm (never a real global install)
// ---------------------------------------------------------------------------

const FAKE_NPM = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "root") {
  process.stdout.write(process.env.FAKE_NPM_ROOT + "\\n");
  process.exit(0);
}
if (args[0] === "install") {
  const code = Number(process.env.FAKE_NPM_EXIT || 0);
  if (code === 0) {
    const spec = args.find((a) => a.startsWith("claude-code-infinite@"));
    const version = spec.split("@")[1];
    const dir = path.join(process.env.FAKE_NPM_ROOT, "claude-code-infinite");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "claude-code-infinite", version }));
  }
  process.stderr.write("fake npm install\\n");
  process.exit(code);
}
process.exit(2);
`;

function runRunner({ global: g, version = "1.0.21", npmRoot, exit = 0, reportedRoot }) {
  const dir = tmpdir("ccc-au-run-");
  const npm = path.join(dir, "npm");
  fs.writeFileSync(npm, FAKE_NPM, { mode: 0o755 });
  const files = updateFiles(path.join(dir, "cfg"));
  fs.mkdirSync(path.dirname(files.lockFile), { recursive: true });
  fs.writeFileSync(files.lockFile, JSON.stringify({ token: "t1", startedAt: Date.now() }));
  const log = path.join(dir, "npm-calls.log");
  fs.writeFileSync(log, "");
  const config = {
    npm, packageName: PKG, version, packageDir: g.packageDir, npmRoot: npmRoot ?? g.npmRoot,
    prefix: g.prefix, ...files, token: "t1", timeoutMs: 30_000,
  };
  const result = spawnSync(process.execPath, ["-e", RUNNER_SOURCE, JSON.stringify(config)], {
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
      FAKE_NPM_LOG: log,
      FAKE_NPM_ROOT: reportedRoot ?? g.npmRoot,
      FAKE_NPM_EXIT: String(exit),
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { files, calls, state: readUpdateState(files.stateFile), lockLeft: fs.existsSync(files.lockFile) };
}

test("runner: installs exactly that version into this prefix, records ok, frees the lock", () => {
  const g = makeGlobal();
  const { calls, state, lockLeft, files } = runRunner({ global: g });
  assert.deepEqual(calls[0], ["root", "--global"]);
  assert.deepEqual(calls[1], [
    "install", "--global", `--prefix=${g.prefix}`, `${PKG}@1.0.21`, "--no-fund", "--no-audit",
  ]);
  assert.equal(state.last.status, "ok");
  assert.equal(state.last.version, "1.0.21");
  assert.equal(lockLeft, false);
  assert.match(fs.readFileSync(files.logFile, "utf8"), /fake npm install[\s\S]*installed 1\.0\.21/);
});

test("runner: npm failure is recorded and frees the lock", () => {
  const { state, lockLeft } = runRunner({ global: makeGlobal(), exit: 1 });
  assert.equal(state.last.status, "failed");
  assert.match(state.last.error, /npm install exited with 1/);
  assert.equal(lockLeft, false);
});

test("runner: a different npm root or a linked entry installs nothing", () => {
  const g = makeGlobal();
  const elsewhere = makeGlobal();
  const wrong = runRunner({ global: g, reportedRoot: elsewhere.npmRoot });
  assert.match(wrong.state.last.error, /wrong prefix/);
  assert.deepEqual(wrong.calls.map((c) => c[0]), ["root"], "never ran install");

  // The entry in npm's root became a link (npm link) since detection.
  const root = tmpdir();
  const linked = makeGlobal(root);
  fs.rmSync(linked.packageDir, { recursive: true });
  const checkout = makePackage(path.join(root, "src", PKG));
  fs.symlinkSync(checkout, linked.packageDir);
  const result = runRunner({ global: { ...linked, packageDir: checkout } });
  assert.match(result.state.last.error, /symlink \(npm link\)/);
  assert.deepEqual(result.calls.map((c) => c[0]), ["root"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(checkout, "package.json"), "utf8")).version, "1.0.20");
});

test("runner: re-validates the version and never calls npm for a hostile one", () => {
  const { state, calls, lockLeft } = runRunner({ global: makeGlobal(), version: "1.0.21; touch /tmp/x" });
  assert.equal(state.last, undefined, "a hostile version is not even recorded as an attempt");
  assert.deepEqual(calls, []);
  assert.equal(lockLeft, false);
});
