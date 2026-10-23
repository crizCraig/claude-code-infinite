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

test("under sudo nothing is written and the install says root", async () => {
  const { base, packageDir, configDir } = setup();
  const { sent, fetchImpl } = capture();
  for (const opts of [{ uid: 0 }, { uid: 501, env: { ...GLOBAL_ENV, SUDO_UID: "501" } }]) {
    await runInstallPing({ env: GLOBAL_ENV, packageDir, configDir, fetchImpl, platform: "linux",
      ...opts });
  }
  assert.equal(existsSync(configDir), false);
  assert.equal(sent.length, 2);
  for (const { body } of sent) {
    assert.equal(body.context.install_method, "root");
    assert.match(body.install_id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(body.events[0], { name: "installed", t: body.events[0].t });
  }
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
  assert.equal(await runInstallPing({ env: GLOBAL_ENV, packageDir, configDir,
    fetchImpl: hanging }), "failed");
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

test("the postinstall script exits 0 whatever happens, without output", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  assert.equal(pkg.scripts.postinstall, "node dist/postinstall.js || exit 0");
  const home = mkdtempSync(join(tmpdir(), "ccc-ping-home-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, DO_NOT_TRACK: "1" };
  const run = spawnSync(process.execPath, [join(ROOT, "dist", "postinstall.js")],
    { env, encoding: "utf-8", timeout: 10_000 });
  assert.equal(run.status, 0);
  assert.equal(run.stdout + run.stderr, "");
  assert.equal(existsSync(join(home, ".claude-code-infinite")), false);
  rmSync(home, { recursive: true, force: true });
});
