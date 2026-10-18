// A ccc started while a Windows update (begun as the last ccc exited) is
// installing waits for it, bounded, instead of loading half-replaced files.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { FRESH_ENTRY_MS, installRunning, waitForUpdateToFinish } from "../dist/update-wait.js";

function lockDir() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccc-wait-")), "update.lock.d");
  fs.mkdirSync(dir);
  return dir;
}

function entry(dir, data, name = "a.json") {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
}

test("only a recent entry naming a live process counts as an install running", () => {
  const dir = lockDir();
  const now = Date.now();
  assert.equal(installRunning(path.join(dir, "missing"), now), false);
  assert.equal(installRunning(dir, now), false);
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  entry(dir, { token: "a", startedAt: now, pid: dead, runner: dead });
  assert.equal(installRunning(dir, now), false, "launcher and runner gone");
  entry(dir, { token: "a", startedAt: now, pid: dead, runner: process.pid });
  assert.equal(installRunning(dir, now), true);
  assert.equal(installRunning(dir, now + FRESH_ENTRY_MS + 1), false, "a stuck lock is not waited on");
  fs.writeFileSync(path.join(dir, "a.json"), "{not json");
  assert.equal(installRunning(dir, now), false);
  entry(dir, { token: "t", startedAt: now, pid: process.pid }, ".a.123.tmp");
  assert.equal(installRunning(dir, now), false, "temp files are not entries");
});

test("waits while the runner lives, says so once, and never past the bound", async () => {
  const dir = lockDir();
  const runner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600)"], { stdio: "ignore" });
  entry(dir, { token: "a", startedAt: Date.now(), runner: runner.pid });
  let told = 0;
  const started = Date.now();
  assert.equal(await waitForUpdateToFinish({ lockDir: dir, pollMs: 50, onWait: () => { told += 1; } }), true);
  assert.ok(Date.now() - started >= 400, "waited for the runner to finish");
  assert.equal(told, 1);

  const stuck = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
  try {
    entry(dir, { token: "a", startedAt: Date.now(), runner: stuck.pid });
    const t0 = Date.now();
    assert.equal(await waitForUpdateToFinish({ lockDir: dir, pollMs: 50, waitMs: 300 }), true);
    assert.ok(Date.now() - t0 < 5000, "bounded");
  } finally {
    stuck.kill();
  }
  fs.rmSync(path.join(dir, "a.json"));
  assert.equal(await waitForUpdateToFinish({ lockDir: dir }), false, "nothing to wait for");
});
