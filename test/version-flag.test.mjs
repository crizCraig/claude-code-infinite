import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// A first-time machine: no ccc config (no MemTree key), no Claude Code, no terminal.
function freshRun(args) {
  const home = mkdtempSync(join(tmpdir(), "ccc-version-"));
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, CCC_NO_DIAGNOSTICS: "1",
    PATH: dirname(process.execPath), Path: dirname(process.execPath),
    LOCALAPPDATA: home, APPDATA: home, ProgramFiles: home,
  };
  return spawnSync(process.execPath, [cli, ...args], { env, input: "", encoding: "utf8", timeout: 20_000 });
}

test("ccc --version prints ccc's own version with no key and no Claude Code", () => {
  for (const flag of ["--version", "-v"]) {
    const run = freshRun([flag]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.split("\n")[0], `${pkg.version} (Claude Code Infinite)`);
    assert.doesNotMatch(run.stdout + run.stderr, /MemTree API key/);
  }
});
