import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

for (const scenario of [
  "before", "guard", "visible", "paste", "paste-split", "answer-burst",
  "cli", "cli-queued", "cli-paid", "cli-unpaid-ahead", "cli-unpaid-quit-ahead",
]) {
  test(`Claude receives the original terminal bytes: ${scenario}`, {
    skip: process.platform === "win32" && "POSIX PTY fixture",
  }, async () => {
    const { stderr } = await promisify(execFile)("python3", [
      "test/fixtures/first-run-pty.py", process.execPath, scenario,
    ], { timeout: 10000 });
    assert.equal(stderr, "");
  });
}
