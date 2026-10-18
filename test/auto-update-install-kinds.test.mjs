// Auto-update across install kinds: linked checkouts are never replaced (and
// never told to `npm i -g`), each package manager gets its own update
// command, results reach diagnostics once, and Windows installs as ccc exits.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectInstallMethod,
  linkedPackageEntry,
  manualUpdateCommand,
  startAutoUpdateInstall,
  takeUnreportedOutcome,
  updateFiles,
  writeUpdateState,
  readUpdateState,
} from "../dist/auto-update.js";
import { setupAutoUpdate } from "../dist/auto-update-setup.js";
import { updateNoticeText } from "../dist/notices.js";

const PKG = "claude-code-infinite";
const UPDATE = { latest: "1.0.24", current: "1.0.22" };
const isWindows = process.platform === "win32";

function tmpdir(label = "ccc-kinds-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), label)));
}

function makePackage(dir, version = "1.0.22") {
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "cli.js"), "");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: PKG, version }));
  return dir;
}

/** A directory link the way `npm link` makes one (a junction on Windows). */
function linkDir(target, at) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, isWindows ? "junction" : "dir");
}

/**
 * `npm link` from a checkout into a POSIX global prefix: the package entry is
 * a link to the checkout and `<prefix>/bin/ccc` links to its dist/cli.js.
 */
function makeNpmLink({ git = true, checkoutParent } = {}) {
  const root = tmpdir();
  const prefix = path.join(root, "prefix");
  const entry = path.join(prefix, "lib", "node_modules", PKG);
  const checkout = makePackage(path.join(checkoutParent ?? path.join(root, "src"), PKG));
  if (git) fs.mkdirSync(path.join(checkout, ".git"));
  linkDir(checkout, entry);
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
  const bin = path.join(prefix, "bin", "ccc");
  if (!isWindows) fs.symlinkSync(`../lib/node_modules/${PKG}/dist/cli.js`, bin);
  return { root, prefix, entry, checkout, bin };
}

function setup(packageDir, extra = {}) {
  return setupAutoUpdate({
    update: UPDATE, currentVersion: "1.0.22", config: {}, configDir: tmpdir("ccc-kinds-cfg-"),
    color: false, env: {}, packageDir, platform: "darwin", uid: 501, ...extra,
  });
}

function mockSpawn() {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return { pid: 4343, unref() {}, on() { return this; } };
  };
  return { spawnImpl, calls };
}

// ---------------------------------------------------------------------------
// Linked installs
// ---------------------------------------------------------------------------

test("Craig's setup: an npm link to a git checkout skips with 'linked install', no npm i -g hint", {
  skip: isWindows && "POSIX bin symlink",
}, () => {
  const link = makeNpmLink();
  // Node reports the checkout itself as the package directory (it resolves the main module).
  const s = setup(link.checkout, { scriptPath: link.bin });
  assert.equal(s.decision.action, "skip");
  assert.equal(s.decision.code, "linked-install");
  assert.match(s.debugLine, /skipped: linked install/);
  assert.equal(s.bannerUpdate.latest, "1.0.24");
  const hint = updateNoticeText(s.bannerUpdate, false);
  assert.doesNotMatch(hint, /npm i -g/, "that command replaced Craig's link with 1.0.24");
  assert.match(hint, /git pull && npm run build/);
});

test("a link whose target looks like a global install is still a link (seen through the bin)", {
  skip: isWindows && "POSIX bin symlink",
}, () => {
  // The checkout sits in another prefix's lib/node_modules and has no .git:
  // its real path alone reads as a writable npm-global install.
  const other = path.join(tmpdir(), "prefix2", "lib", "node_modules");
  fs.mkdirSync(path.join(path.dirname(path.dirname(other)), "bin"), { recursive: true });
  const link = makeNpmLink({ git: false, checkoutParent: other });
  assert.equal(detectInstallMethod({ packageDir: link.checkout, platform: "darwin", uid: 501 }).kind,
    "npm-global", "without the script path it would self-update");
  const m = detectInstallMethod({
    packageDir: link.checkout, scriptPath: link.bin, platform: "darwin", uid: 501,
  });
  assert.equal(m.kind, "npm-link");
  assert.equal(linkedPackageEntry(link.bin), link.entry);
  const { spawnImpl, calls } = mockSpawn();
  const s = setup(link.checkout, { scriptPath: link.bin, spawnImpl });
  assert.equal(s.decision.code, "linked-install");
  s.scheduleInstall(0);
  s.installOnExit();
  assert.equal(calls.length, 0, "nothing is ever spawned for a link");
});

test("Windows: a junctioned package entry (npm link) is seen through the script path", () => {
  const root = tmpdir();
  const prefix = path.join(root, "npm");
  const entry = path.join(prefix, "node_modules", PKG);
  const checkout = makePackage(path.join(root, "src", PKG));
  linkDir(checkout, entry);
  fs.writeFileSync(path.join(prefix, "ccc.cmd"), "");
  // ccc.cmd runs node with the lexical path under node_modules.
  const script = path.join(entry, "dist", "cli.js");
  assert.equal(linkedPackageEntry(script), entry);
  const m = detectInstallMethod({ packageDir: checkout, scriptPath: script, platform: "win32" });
  assert.equal(m.kind, "npm-link");
});

test("pnpm's symlinked package entry is pnpm, not an npm link", () => {
  const root = tmpdir();
  const store = makePackage(path.join(root, "pnpm", "global", "5", "node_modules", ".pnpm",
    `${PKG}@1.0.22`, "node_modules", PKG));
  const entry = path.join(root, "pnpm", "global", "5", "node_modules", PKG);
  linkDir(store, entry);
  const script = path.join(entry, "dist", "cli.js");
  assert.equal(linkedPackageEntry(script), entry, "the entry is a symlink");
  const m = detectInstallMethod({ packageDir: store, scriptPath: script, platform: "darwin", uid: 501 });
  assert.equal(m.kind, "pnpm");
  assert.equal(manualUpdateCommand(m.kind), `pnpm add -g ${PKG}@latest`);
});

test("a plain global install's script path is not a link", () => {
  const prefix = path.join(tmpdir(), "prefix");
  const entry = makePackage(path.join(prefix, "lib", "node_modules", PKG));
  assert.equal(linkedPackageEntry(path.join(entry, "dist", "cli.js")), null);
  assert.equal(linkedPackageEntry(path.join(prefix, "missing", "cli.js")), null);
});

// ---------------------------------------------------------------------------
// The manual command per install kind
// ---------------------------------------------------------------------------

test("each install kind is told its own update command", () => {
  const spec = `${PKG}@latest`;
  assert.equal(manualUpdateCommand("npm-global"), `npm i -g ${spec}`);
  assert.equal(manualUpdateCommand("not-writable"), `npm i -g ${spec}`);
  assert.equal(manualUpdateCommand("unknown"), `npm i -g ${spec}`);
  assert.equal(manualUpdateCommand("pnpm"), `pnpm add -g ${spec}`);
  assert.equal(manualUpdateCommand("yarn"), `yarn global add ${spec}`);
  assert.equal(manualUpdateCommand("bun"), `bun add -g ${spec}`);
  assert.equal(manualUpdateCommand("volta"), `volta install ${spec}`);
  assert.equal(manualUpdateCommand("npx"), `npx ${spec}`);
  for (const kind of ["npm-link", "git-checkout"]) {
    assert.doesNotMatch(manualUpdateCommand(kind), /npm i -g/);
  }
  // The default command is not repeated in the banner object.
  const plain = updateNoticeText(UPDATE, false);
  assert.match(plain, /npm i -g claude-code-infinite@latest$/);
  assert.match(updateNoticeText({ ...UPDATE, command: "pnpm add -g x\u001b[31m" }, false),
    /· pnpm add -g x \[31m$/, "control characters cannot reach the terminal");
});

// ---------------------------------------------------------------------------
// Diagnostics: the last install's result, once
// ---------------------------------------------------------------------------

test("the last background install's result is reported once", () => {
  const { stateFile } = updateFiles(tmpdir("ccc-kinds-cfg-"));
  assert.equal(takeUnreportedOutcome(stateFile), null, "no attempt yet");
  const last = { version: "1.0.24", status: "running", at: 1, packageDir: "/p" };
  writeUpdateState(stateFile, { attempts: { "1.0.24": 1 }, last });
  assert.equal(takeUnreportedOutcome(stateFile), null, "still running");
  writeUpdateState(stateFile, { attempts: { "1.0.24": 1 }, last: { ...last, status: "ok" } });
  assert.equal(takeUnreportedOutcome(stateFile), "ok");
  assert.equal(takeUnreportedOutcome(stateFile), null, "only once");
  assert.equal(readUpdateState(stateFile).attempts["1.0.24"], 1, "bookkeeping kept");
  writeUpdateState(stateFile, { attempts: {}, last: { ...last, status: "failed", error: "x" } });
  // While an installer holds the lock it may be writing the state file: wait.
  const { lockDir } = updateFiles(path.dirname(stateFile));
  fs.mkdirSync(lockDir, { recursive: true });
  const entry = path.join(lockDir, "live.json");
  fs.writeFileSync(entry, JSON.stringify({ token: "live", startedAt: Date.now(), pid: process.pid }));
  assert.equal(takeUnreportedOutcome(stateFile, lockDir), null, "lock held");
  fs.rmSync(entry);
  assert.equal(takeUnreportedOutcome(stateFile, lockDir), "failed");
  assert.equal(takeUnreportedOutcome(stateFile), null);
});

// ---------------------------------------------------------------------------
// Windows: install as ccc exits, npm as `node npm-cli.js`
// ---------------------------------------------------------------------------

function makeWindowsGlobal() {
  const root = tmpdir();
  const prefix = path.join(root, "npm");
  const packageDir = makePackage(path.join(prefix, "node_modules", PKG));
  fs.writeFileSync(path.join(prefix, "ccc.cmd"), "");
  // A Node install with npm beside node.exe.
  const nodeDir = path.join(root, "nodejs");
  const cli = path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "");
  return { root, prefix, packageDir, execPath: path.join(nodeDir, "node.exe"), cli };
}

function windowsInstall(g, extra = {}) {
  const method = detectInstallMethod({ packageDir: g.packageDir, platform: "win32" });
  assert.equal(method.kind, "npm-global", method.detail);
  const files = updateFiles(tmpdir("ccc-kinds-cfg-"));
  const { spawnImpl, calls } = mockSpawn();
  const result = startAutoUpdateInstall({
    decision: { action: "install", version: "1.0.24", method }, files, spawnImpl,
    platform: "win32", execPath: g.execPath, env: { Path: "C:\\Windows" }, waitForPid: 777, ...extra,
  });
  return { result, calls, files };
}

test("Windows: the runner gets `node npm-cli.js`, the pid to wait for, and no console window", () => {
  const g = makeWindowsGlobal();
  const { result, calls } = windowsInstall(g);
  assert.equal(result, "started");
  const { command, args, options } = calls[0];
  assert.equal(command, g.execPath);
  const config = JSON.parse(args[2]);
  assert.equal(config.npm, g.execPath);
  assert.deepEqual(config.npmArgs, [g.cli]);
  assert.equal(config.waitForPid, 777);
  assert.equal(config.prefix, g.prefix);
  assert.equal(options.detached, true);
  assert.equal(options.windowsHide, true);
  assert.match(options.env.Path, /nodejs;C:\\Windows$/, "this Node first, on Windows' own Path key");
  assert.equal(options.env.PATH, undefined, "no second PATH key beside Path");
});

test("Windows: npm-cli.js found beside an npm.cmd on PATH (nvm-windows, a moved Node)", () => {
  const g = makeWindowsGlobal();
  const npmDir = path.join(g.root, "elsewhere");
  const cli = path.join(npmDir, "node_modules", "npm", "bin", "npm-cli.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "");
  fs.writeFileSync(path.join(npmDir, "npm.cmd"), "");
  const { result, calls } = windowsInstall(g, {
    execPath: path.join(g.root, "bare", "node.exe"), env: { Path: npmDir },
  });
  assert.equal(result, "started");
  assert.deepEqual(JSON.parse(calls[0].args[2]).npmArgs, [cli]);
});

test("Windows: without npm-cli.js nothing runs; the attempt is a recorded failure", () => {
  const g = makeWindowsGlobal();
  fs.rmSync(g.cli);
  const { result, calls, files } = windowsInstall(g);
  assert.equal(result, "spawn-failed");
  assert.equal(calls.length, 0);
  assert.equal(readUpdateState(files.stateFile).last.status, "failed");
  assert.equal(takeUnreportedOutcome(files.stateFile), null, "this launch reported it already");
  assert.deepEqual(fs.readdirSync(files.lockDir).filter((n) => n.endsWith(".json")), []);
});

test("Windows: setup installs only on exit, once, waiting for this ccc's pid", () => {
  const g = makeWindowsGlobal();
  const { spawnImpl, calls } = mockSpawn();
  const s = setup(g.packageDir, {
    platform: "win32", uid: undefined, spawnImpl, pid: 999, execPath: g.execPath,
  });
  assert.equal(s.decision.action, "install", s.debugLine);
  assert.deepEqual(s.bannerUpdate, { ...UPDATE, command: "installs when you exit ccc" },
    "nothing installs during the session: the banner says when it will");
  assert.match(updateNoticeText(s.bannerUpdate, false), /1\.0\.24 is available .* installs when you exit ccc$/);
  s.scheduleInstall(0);
  assert.equal(calls.length, 0, "never while ccc runs");
  const results = [];
  s.installOnExit((r) => results.push(r));
  s.installOnExit((r) => results.push(r));
  assert.deepEqual(results, ["started"]);
  assert.equal(calls.length, 1);
  const config = JSON.parse(calls[0].args[2]);
  assert.equal(config.waitForPid, 999);
  assert.deepEqual(config.npmArgs, [g.cli]);
  assert.equal(results.length, 1, "only once");
});

test("POSIX: installOnExit is a no-op; the delayed install is the only path", () => {
  const prefix = path.join(tmpdir(), "prefix");
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
  const dir = makePackage(path.join(prefix, "lib", "node_modules", PKG));
  const { spawnImpl, calls } = mockSpawn();
  const s = setup(dir, { spawnImpl });
  assert.equal(s.decision.action, "install", s.debugLine);
  s.installOnExit();
  assert.equal(calls.length, 0);
});

test("diagnostics allow every skip reason and result auto-update reports", async () => {
  const { SKIP_CODES } = await import("../dist/auto-update.js");
  const { AUTO_UPDATE_REASONS, sanitizeEvent } = await import("../dist/diagnostics-schema.js");
  assert.deepEqual([...AUTO_UPDATE_REASONS], [...SKIP_CODES]);
  for (const result of ["started", "skipped", "installed", "ok", "failed", "spawn-failed"]) {
    assert.equal(sanitizeEvent("auto_update", { result }, 1).result, result);
  }
  assert.deepEqual(sanitizeEvent("auto_update", { result: "skipped", reason: "linked-install" }, 1),
    { result: "skipped", reason: "linked-install", name: "auto_update", t: 1 });
  assert.equal(sanitizeEvent("auto_update", { reason: "/Users/ada/src" }, 1).reason, undefined);
});

test("yarn and Volta on Windows are recognised (their folders, any case)", () => {
  const yarn = makePackage(path.join(tmpdir(), "AppData", "Local", "Yarn", "Data", "global",
    "node_modules", PKG));
  assert.equal(detectInstallMethod({ packageDir: yarn, platform: "win32" }).kind, "yarn");
  const volta = makePackage(path.join(tmpdir(), "AppData", "Local", "Volta", "tools", "image",
    "packages", PKG, "node_modules", PKG));
  assert.equal(detectInstallMethod({ packageDir: volta, platform: "win32" }).kind, "volta");
});

test("a link to a folder without git is told to rebuild that folder, not to git pull", () => {
  assert.match(manualUpdateCommand("npm-link"), /update and rebuild the folder it links to/);
  assert.match(manualUpdateCommand("git-checkout"), /git pull && npm run build/);
});
