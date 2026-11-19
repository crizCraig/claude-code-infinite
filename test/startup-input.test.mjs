import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("first run rejects malformed input and saves and sends the trimmed key", {
  skip: process.platform === "win32" && "POSIX PTY",
}, async t => {
  try {
    await promisify(execFile)("python3", ["test/fixtures/startup-input.py", process.execPath], { timeout: 15000 });
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    t.skip("The POSIX startup-input test needs python3 for its PTY fixture.");
  }
});
