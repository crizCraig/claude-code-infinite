// Runs every test/*.test.mjs with node --test. A script rather than a shell
// glob because npm runs scripts under cmd.exe on Windows, which does not
// expand globs, and Node 20 (our minimum engine) does not expand them itself.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test");
const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(testDir, name));

const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
