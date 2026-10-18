// End to end against the real npm registry (CI only: CCC_E2E_NPM=1): install a
// published ccc into a throwaway global prefix, then let the auto-updater's
// detached runner update it to a newer published release, exactly as a user's
// launch would (on Windows: started as ccc exits, waiting for its pid).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectInstallMethod,
  readInstalledVersion,
  readUpdateState,
  startAutoUpdateInstall,
  updateFiles,
} from "../dist/auto-update.js";

const FROM = "1.0.22";
const TO = "1.0.24";
const isWindows = process.platform === "win32";
const skip = process.env.CCC_E2E_NPM !== "1" && "set CCC_E2E_NPM=1 (uses the npm registry)";

/** The npm that ships with this Node, run without a shell. */
function npm(args, env) {
  const cli = path.join(path.dirname(process.execPath),
    ...(isWindows ? [] : ["..", "lib"]), "node_modules", "npm", "bin", "npm-cli.js");
  return spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 300_000 });
}

async function until(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

test(`a real global install updates itself ${FROM} → ${TO}`, { skip, timeout: 600_000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccc-e2e-")));
  const prefix = path.join(root, "prefix");
  // npm root -g must name this prefix for the runner to install (it checks).
  const env = { ...process.env, npm_config_prefix: prefix, npm_config_update_notifier: "false" };
  const installed = npm(["install", "--global", `claude-code-infinite@${FROM}`, "--no-fund",
    "--no-audit"], env);
  assert.equal(installed.status, 0, installed.stderr);
  const npmRoot = isWindows ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules");
  const packageDir = path.join(npmRoot, "claude-code-infinite");
  const shim = isWindows ? path.join(prefix, "ccc.cmd") : path.join(prefix, "bin", "ccc");
  assert.ok(fs.existsSync(shim), "npm made the ccc shim");
  const method = detectInstallMethod({ packageDir, env, uid: process.getuid?.() });
  assert.equal(method.kind, "npm-global", method.detail);

  // Stands in for the ccc that is exiting (Windows waits for it).
  const ccc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], { stdio: "ignore" });
  const files = updateFiles(path.join(root, "cfg"));
  const result = startAutoUpdateInstall({
    decision: { action: "install", version: TO, method }, files,
    spawnImpl: spawn, env, ...(isWindows ? { waitForPid: ccc.pid } : {}),
  });
  assert.equal(result, "started");
  const done = await until(() => readUpdateState(files.stateFile).last?.status !== "running", 480_000);
  const last = readUpdateState(files.stateFile).last;
  const log = fs.existsSync(files.logFile) ? fs.readFileSync(files.logFile, "utf8") : "";
  assert.ok(done, `the runner finished\n${log}`);
  assert.equal(last.status, "ok", `${last.error}\n${log}`);
  assert.equal(readInstalledVersion(packageDir), TO);
  assert.ok(fs.existsSync(shim), "the shim is still there");
  assert.ok(fs.existsSync(path.join(packageDir, "dist", "cli.js")), "the new files are in place");
});
