import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Diagnostics,
  FIRST_RUN_PENDING_FILE,
  INSTALL_ID_FILE,
} from "../dist/diagnostics.js";
import {
  INSTALL_PING_TIMEOUT_MS,
  installMethod,
  isCi,
  isDevInstall,
  runInstallPing,
} from "../dist/install-ping.js";
import { AUTO_UPDATE_ENV } from "../dist/auto-update.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NOW = 1_760_640_000_000;

/** A fake installed package (outside any git checkout) and an empty config folder. */
function setup(version = "1.0.31") {
  const base = mkdtempSync(join(tmpdir(), "ccc-ping-"));
  const packageDir = join(base, "lib", "node_modules", "claude-code-infinite");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ version }));
  const configDir = join(base, "home", ".claude-code-infinite");
  return { base, packageDir, configDir };
}

function capture() {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 202 };
  };
  return { sent, fetchImpl };
}

const GLOBAL_ENV = { npm_config_global: "true", INIT_CWD: "/somewhere/else" };

test("one anonymous installed event: versions, platform, method, install id; nothing else", async () => {
  const { base, packageDir, configDir } = setup();
  const { sent, fetchImpl } = capture();
  const env = {
    ...GLOBAL_ENV, HOME: "/Users/alice", USER: "alice", ANTHROPIC_API_KEY: "sk-ant-api03-secret",
    npm_config_cache: "/Users/alice/.npm",
  };
  const result = await runInstallPing({ env, packageDir, configDir, fetchImpl, now: () => NOW,
    uid: 501, platform: "darwin" });
  assert.equal(result, "sent");
  assert.equal(sent.length, 1);
  const { url, init, body } = sent[0];
  assert.equal(url, "https://api.polychat.co/v1/ccc/diagnostics");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.authorization, undefined, "never a key");
  const id = readFileSync(join(configDir, INSTALL_ID_FILE), "utf-8").trim();
  assert.deepEqual(body, {
    schema: 1, install_id: id,
    context: { ccc_version: "1.0.31", node: process.versions.node.split(".").slice(0, 3).join("."),
               os: "darwin", arch: process.arch, install_method: "npm-global" },
    events: [{ name: "installed", new_install: true, t: NOW }],
  });
  const text = init.body;
  for (const leak of ["alice", "sk-ant", base, ".npm", "/Users"]) {
    assert.equal(text.includes(leak), false, leak);
  }
  rmSync(base, { recursive: true, force: true });
});

test("the install id joins the first run: same id, first_run still recorded once", async () => {
  const { base, packageDir, configDir } = setup();
  const { sent, fetchImpl } = capture();
  await runInstallPing({ env: GLOBAL_ENV, packageDir, configDir, fetchImpl, uid: 501 });
  assert.equal(existsSync(join(configDir, FIRST_RUN_PENDING_FILE)), true);
  const launch = capture();
  const diagnostics = new Diagnostics({
    baseUrl: "https://api.example.test", configDir, clientName: "cc-infinite",
    clientVersion: "1.0.31", env: {}, config: {}, fetchImpl: launch.fetchImpl, now: () => NOW,
  });
  assert.equal(diagnostics.firstRun, true, "the ping created the id, not this launch");
  assert.equal(existsSync(join(configDir, FIRST_RUN_PENDING_FILE)), false);
  diagnostics.record("first_run");
  await diagnostics.flush(200);
  assert.equal(launch.sent[0].body.install_id, sent[0].body.install_id);
  const again = new Diagnostics({
    baseUrl: "https://api.example.test", configDir, clientName: "cc-infinite",
    clientVersion: "1.0.31", env: {}, config: {}, fetchImpl: launch.fetchImpl,
  });
  assert.equal(again.firstRun, false);
  rmSync(base, { recursive: true, force: true });
});

test("a reinstall or upgrade says new_install false and leaves no first-run marker", async () => {
  const { base, packageDir, configDir } = setup();
  mkdirSync(configDir, { recursive: true });
  const id = "3f2b8c1e-9d4a-4b7e-8c21-5a6f0e9d1b23";
  writeFileSync(join(configDir, INSTALL_ID_FILE), `${id}\n`);
  const { sent, fetchImpl } = capture();
  await runInstallPing({ env: GLOBAL_ENV, packageDir, configDir, fetchImpl, uid: 501 });
  assert.equal(sent[0].body.install_id, id);
  assert.equal(sent[0].body.events[0].new_install, false);
  assert.equal(existsSync(join(configDir, FIRST_RUN_PENDING_FILE)), false);
  rmSync(base, { recursive: true, force: true });
});

test("opt-outs, CI, a ccc checkout and ccc's own updates send nothing and write nothing", async () => {
  const cases = [
    [{ CCC_NO_DIAGNOSTICS: "1" }, "opted-out"], [{ DO_NOT_TRACK: "1" }, "opted-out"],
    [{ DISABLE_TELEMETRY: "1" }, "opted-out"],
    [{ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "true" }, "opted-out"],
    [{ CI: "true" }, "ci"], [{ GITHUB_ACTIONS: "true" }, "ci"], [{ BUILDKITE: "1" }, "ci"],
    [{ [AUTO_UPDATE_ENV]: "1" }, "auto-update"],
  ];
  for (const [extra, reason] of cases) {
    const { base, packageDir, configDir } = setup();
    const { sent, fetchImpl } = capture();
    const result = await runInstallPing({ env: { ...GLOBAL_ENV, ...extra }, packageDir,
      configDir, fetchImpl, uid: 501 });
    assert.equal(result, reason, JSON.stringify(extra));
    assert.equal(sent.length, 0);
    assert.equal(existsSync(configDir), false, "no install id written");
    rmSync(base, { recursive: true, force: true });
  }
  const { base, packageDir, configDir } = setup();
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ diagnostics: false }));
  const { sent, fetchImpl } = capture();
  assert.equal(await runInstallPing({ env: GLOBAL_ENV, packageDir, configDir, fetchImpl }),
    "opted-out");
  assert.equal(sent.length, 0);
  const dev = await runInstallPing({ env: { INIT_CWD: ROOT }, packageDir: ROOT,
    configDir: join(base, "unused"), fetchImpl });
  assert.equal(dev, "dev-install", "npm install inside the ccc checkout");
  rmSync(base, { recursive: true, force: true });
});

test("under sudo or as root: no send and nothing written (sudo drops the user's opt-outs)", async () => {
  const { base, packageDir, configDir } = setup();
  const { sent, fetchImpl } = capture();
  for (const opts of [{ uid: 0 }, { uid: 501, env: { ...GLOBAL_ENV, SUDO_UID: "501" } }]) {
    const result = await runInstallPing({ env: GLOBAL_ENV, packageDir, configDir, fetchImpl,
      platform: "linux", ...opts });
    assert.equal(result, "root");
  }
  assert.equal(existsSync(configDir), false);
  assert.equal(sent.length, 0);
  rmSync(base, { recursive: true, force: true });
});

test("a failing or hanging send never throws and gives up at the timeout", async () => {
  const { base, packageDir, configDir } = setup();
  const failing = async () => {
    throw new Error("ENOTFOUND api.polychat.co");
  };
  assert.equal(await runInstallPing({ env: GLOBAL_ENV, packageDir, configDir,
    fetchImpl: failing }), "failed");
  const hanging = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  });
  const started = Date.now();
  // AbortSignal.timeout's timer doesn't hold the event loop open (a real socket does).
  const keepAlive = setInterval(() => {}, 1000);
  const result = await runInstallPing({ env: GLOBAL_ENV, packageDir, configDir,
    fetchImpl: hanging });
  clearInterval(keepAlive);
  assert.equal(result, "failed");
  const took = Date.now() - started;
  assert.ok(took >= INSTALL_PING_TIMEOUT_MS - 100 && took < INSTALL_PING_TIMEOUT_MS + 1500, took);
  rmSync(base, { recursive: true, force: true });
});

test("install method from npm's own environment and the package folder", () => {
  const global = "/usr/local/lib/node_modules/claude-code-infinite";
  assert.equal(installMethod({ npm_config_global: "true" }, global), "npm-global");
  assert.equal(installMethod({ npm_config_location: "global" }, global), "npm-global");
  assert.equal(installMethod({}, "/home/a/proj/node_modules/claude-code-infinite"), "local");
  assert.equal(installMethod({ npm_config_global: "true" },
    "/home/a/.npm/_npx/1a2b/node_modules/claude-code-infinite"), "npx");
  assert.equal(installMethod({ npm_config_user_agent: "pnpm/9.1.0 npm/? node/v22" }, global),
    "pnpm");
  assert.equal(installMethod({}, "/home/a/.volta/tools/image/packages/x"), "volta");
});

test("CI detection: flags that say false are not CI", () => {
  assert.equal(isCi({}), false);
  assert.equal(isCi({ CI: "false" }), false);
  assert.equal(isCi({ CI: "0" }), false);
  assert.equal(isCi({ CI: "1" }), true);
  assert.equal(isCi({ JENKINS_URL: "x" }), true);
  assert.equal(isDevInstall({}, ROOT), true, "this checkout has .git");
});

test("the npm postinstall runs with npm’s Node executable when PATH is empty", t => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  const home = mkdtempSync(join(tmpdir(), "ccc-ping-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const marker = join(home, "ran-postinstall");
  const preload = join(home, "observe.cjs");
  writeFileSync(preload, `if (require("node:path").basename(process.argv[1]) === "postinstall.js")
    require("node:fs").writeFileSync(process.env.CCC_PING_MARKER, process.execPath);`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, DO_NOT_TRACK: "1",
    npm_node_execpath: process.execPath, NODE_OPTIONS: `--require="${preload.replaceAll("\\", "/")}"`, CCC_PING_MARKER: marker };
  for (const name of Object.keys(env)) if (name.toUpperCase() === "PATH") delete env[name];
  env.PATH = "";
  const run = spawnSync(pkg.scripts.postinstall, {
    cwd: ROOT, env, shell: process.platform === "win32" ? process.env.ComSpec : "/bin/sh", encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout + run.stderr, "");
  assert.equal(readFileSync(marker, "utf8"), process.execPath);
  assert.equal(existsSync(join(home, ".claude-code-infinite")), false);
});

test("postinstall launcher selects absolute Node directly on POSIX/Yarn Berry and postinstall.cmd on Windows cmd.exe", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  const script = pkg.scripts.postinstall;
  const cmdFile = readFileSync(join(ROOT, "postinstall.cmd"), "utf-8");

  assert.ok(Array.isArray(pkg.files) && pkg.files.includes("postinstall.cmd"));
  // POSIX sh and Yarn Berry (@yarnpkg/shell) treat '...' as a single-quoted literal argument to `echo`.
  // The commands outside '...' must never spawn ./postinstall.cmd (avoids Yarn 2-4 ENOEXEC) or bare `node`.
  const posixCommands = script.replace(/'[^']*'/g, "''");
  assert.doesNotMatch(posixCommands, /postinstall\.cmd/, "POSIX/Yarn Berry must not spawn shebang-less .cmd");
  assert.doesNotMatch(posixCommands, /(^|[\s;&|(])node(\s|$)/, "must never spawn bare node");
  assert.match(posixCommands, /^echo '' >\/dev\/null && "\$\{npm_node_execpath:-:\}" dist\/postinstall\.js \|\| exit 0$/);

  // Windows cmd.exe treats `'` as a plain character, executes only the prefix up to `& exit 0`,
  // and never reaches the POSIX branch or spawns bare `node`.
  const [windowsPrefix] = script.split("& exit 0");
  assert.notEqual(windowsPrefix, script, "Windows cmd.exe branch must terminate with & exit 0");
  assert.equal(windowsPrefix.trim(), "echo ' >nul & (\"./postinstall.cmd\")");
  assert.doesNotMatch(windowsPrefix, /(^|[\s;&|(])node(\s|$)/, "Windows prefix must never spawn bare node");

  // postinstall.cmd uses only npm/pnpm/Yarn's absolute Node path and exits 0 when unset.
  assert.match(cmdFile, /@if not defined npm_node_execpath exit \/b 0/);
  assert.match(cmdFile, /@"%npm_node_execpath%" dist\/postinstall\.js/);
  assert.doesNotMatch(cmdFile, /(^|\s)node(\s|$)/m, "postinstall.cmd must never spawn bare node");
});

test("POSIX postinstall runs without postinstall.cmd and ignores a hostile cwd/node", {
  skip: process.platform === "win32",
}, t => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  const dir = mkdtempSync(join(tmpdir(), "ccc-postinstall-posix-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const marker = join(dir, "ran");
  const hostile = join(dir, "hostile-ran");
  writeFileSync(join(dir, "dist", "postinstall.js"),
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, process.execPath);`);
  // No postinstall.cmd in `dir` at all: proves POSIX sh does not depend on ./postinstall.cmd or ENOEXEC fallback.
  writeFileSync(join(dir, "node"), `#!/bin/sh\necho pwn > ${JSON.stringify(hostile)}\n`, { mode: 0o755 });

  const env = { ...process.env, HOME: dir, DO_NOT_TRACK: "1", npm_node_execpath: process.execPath };
  for (const name of Object.keys(env)) if (name.toUpperCase() === "PATH") delete env[name];
  env.PATH = "";
  const run = spawnSync(pkg.scripts.postinstall, { cwd: dir, env, shell: "/bin/sh", encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout + run.stderr, "");
  assert.equal(readFileSync(marker, "utf8"), process.execPath);
  assert.equal(existsSync(hostile), false);

  // When npm_node_execpath is unset, exits 0 silently without invoking bare `node`.
  const unsetEnv = { ...env, PATH: dir };
  delete unsetEnv.npm_node_execpath;
  const unsetRun = spawnSync(pkg.scripts.postinstall, { cwd: dir, env: unsetEnv, shell: "/bin/sh", encoding: "utf8" });
  assert.equal(unsetRun.status, 0, unsetRun.stderr);
  assert.equal(unsetRun.stdout + unsetRun.stderr, "");
  assert.equal(existsSync(hostile), false);
});

test("Windows postinstall exits 0 without touching cwd/node.cmd when npm_node_execpath is unset", {
  skip: process.platform !== "win32",
}, t => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  const dir = mkdtempSync(join(tmpdir(), "ccc-postinstall-win-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "postinstall.cmd"), readFileSync(join(ROOT, "postinstall.cmd")));
  const hostile = join(dir, "hostile-ran");
  writeFileSync(join(dir, "node.cmd"), `@echo pwn > "${hostile}"\r\n`);
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, DO_NOT_TRACK: "1" };
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === "PATH" || name.toUpperCase() === "NPM_NODE_EXECPATH") delete env[name];
  }
  env.PATH = "";
  const run = spawnSync(pkg.scripts.postinstall, { cwd: dir, env, shell: process.env.ComSpec, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout + run.stderr, "");
  assert.equal(existsSync(hostile), false);
});
