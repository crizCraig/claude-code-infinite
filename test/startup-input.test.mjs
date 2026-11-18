import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

for (const scenario of ["rejected-key", "unpaid-without-python", "print-key"]) {
  test(`startup terminal: ${scenario}`, { skip: process.platform === "win32" && "POSIX PTY" }, async () => {
    await promisify(execFile)("python3", ["test/fixtures/startup-input.py", process.execPath, scenario],
      { timeout: 10000 });
  });
}
