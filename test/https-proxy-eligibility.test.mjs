// When HTTPS-proxy mode runs, and when it falls back to the base-URL mode (with a reason).
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  httpsProxyModeDecision, httpsProxyModeRequested, settingsArgs, skippedNoticeText,
} from "../dist/https-proxy-eligibility.js";

const HOME = "/home/u";
// The mode is off on Windows before any settings are read; these use POSIX paths.
const POSIX = { skip: process.platform === "win32" };
const CWD = "/work/repo/sub";

function decide({ env = { CCC_HTTPS_PROXY_MODE: "1" }, files = {}, args = [], platform = "linux",
  configured, dropIns = [] } = {}) {
  return httpsProxyModeDecision({
    env, configured, platform, claudeArgs: args, cwd: CWD, homedir: HOME,
    readFile: (file) => (Object.hasOwn(files, file) ? files[file] : null),
    listDir: () => dropIns,
  });
}

test("off unless asked for; the env var wins over the config key", () => {
  assert.deepEqual(decide({ env: {} }), { mode: "base-url", requested: false });
  assert.deepEqual(decide({ env: {}, configured: true }), { mode: "https-proxy" });
  assert.deepEqual(decide({ env: { CCC_HTTPS_PROXY_MODE: "0" }, configured: true }),
    { mode: "base-url", requested: false });
  for (const on of ["1", "true", "YES", " on "]) {
    assert.equal(httpsProxyModeRequested({ CCC_HTTPS_PROXY_MODE: on }), true, on);
  }
  for (const off of ["0", "false", "no", "off", "", "maybe"]) {
    assert.equal(httpsProxyModeRequested({ CCC_HTTPS_PROXY_MODE: off }), false, off);
  }
  assert.equal(httpsProxyModeRequested({ CCC_HTTPS_PROXY_MODE: "maybe" }, true), true);
});

test("Windows and a proxy in ccc's own env keep the base-URL mode", () => {
  assert.match(decide({ platform: "win32" }).reason, /Windows/);
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "ALL_PROXY", "all_proxy"]) {
    const d = decide({ env: { CCC_HTTPS_PROXY_MODE: "1", [name]: "http://corp:3128" } });
    assert.equal(d.mode, "base-url", name);
    assert.match(d.reason, new RegExp(name));
  }
  assert.equal(decide({ env: { CCC_HTTPS_PROXY_MODE: "1", HTTPS_PROXY: " " } }).mode,
    "https-proxy", "an empty proxy is none");
  assert.equal(decide({ platform: "darwin" }).mode, "https-proxy");
});

test("settings env with a proxy, NO_PROXY or a CA, in any scope, keeps the base-URL mode", POSIX, () => {
  const scopes = [
    path.join(HOME, ".claude", "settings.json"),
    path.join(HOME, ".claude", "settings.local.json"),
    path.join(CWD, ".claude", "settings.json"),
    path.join(CWD, ".claude", "settings.local.json"),
    path.join("/work/repo", ".claude", "settings.json"),
    "/etc/claude-code/managed-settings.json",
  ];
  for (const file of scopes) {
    for (const key of ["HTTPS_PROXY", "no_proxy", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "http_proxy"]) {
      const d = decide({ files: { [file]: JSON.stringify({ env: { [key]: "" } }) } });
      assert.equal(d.mode, "base-url", `${file} ${key}`);
      assert.match(d.reason, new RegExp(`${key} is set in ${file.replace(/[.]/g, "\\.")}`));
    }
  }
  const unrelated = decide({ files: { [scopes[0]]: JSON.stringify({ env: { FOO: "1" } }) } });
  assert.equal(unrelated.mode, "https-proxy");
  assert.equal(decide({ files: { [scopes[0]]: "{not json" } }).mode, "https-proxy");
});

test("the Bash sandbox enabled anywhere keeps the base-URL mode", POSIX, () => {
  const user = path.join(HOME, ".claude", "settings.json");
  const d = decide({ files: { [user]: JSON.stringify({ sandbox: { enabled: true } }) } });
  assert.match(d.reason, /sandbox is on/);
  assert.equal(decide({ files: { [user]: JSON.stringify({ sandbox: { enabled: false } }) } }).mode,
    "https-proxy");
  const dropIn = decide({ dropIns: ["10-sec.json"],
    files: { "/etc/claude-code/managed-settings.d/10-sec.json": '{"sandbox":{"enabled":true}}' } });
  assert.match(dropIn.reason, /managed-settings\.d/);
  const mac = decide({ platform: "darwin", files: {
    "/Library/Application Support/ClaudeCode/managed-settings.json": '{"sandbox":{"enabled":true}}',
  } });
  assert.equal(mac.mode, "base-url");
});

test("CLAUDE_CONFIG_DIR moves the user settings it reads", POSIX, () => {
  const d = decide({ env: { CCC_HTTPS_PROXY_MODE: "1", CLAUDE_CONFIG_DIR: "/cfg" },
    files: { "/cfg/settings.json": '{"env":{"HTTPS_PROXY":"x"}}' } });
  assert.match(d.reason, /\/cfg\/settings\.json/);
});

test("--settings, inline JSON or a file, is read too", POSIX, () => {
  assert.match(decide({ args: ["--settings", '{"sandbox":{"enabled":true}}'] }).reason,
    /--settings/);
  assert.match(decide({ args: ["--settings=s.json"],
    files: { [path.join(CWD, "s.json")]: '{"env":{"NODE_EXTRA_CA_CERTS":"/c.pem"}}' } }).reason,
  /NODE_EXTRA_CA_CERTS/);
  assert.equal(decide({ args: ["--", "--settings", '{"sandbox":{"enabled":true}}'] }).mode,
    "https-proxy", "after -- it's the prompt");
  assert.deepEqual(settingsArgs(["-p", "--settings", "a", "--settings=b", "--settings"]),
    ["a", "b"]);
});

test("the skipped notice names the reason and the fallback", () => {
  assert.equal(skippedNoticeText("Windows isn't supported yet"),
    "ccc: HTTPS-proxy mode (Remote Control) is off for this session: Windows isn't supported " +
    "yet. Using the base-URL mode.");
});
