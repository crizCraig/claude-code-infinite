import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const cli = new URL("../dist/cli.js", import.meta.url);
function runVersion(version, entry = cli) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });
    process.argv = [process.execPath, ${JSON.stringify(entry.pathname)}, "fetch"];
    await import(${JSON.stringify(entry.href)});
  `], { encoding: "utf8", timeout: 5_000 });
}

test("runtime requirements agree in the package, lockfile and installation docs", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(pkg.engines?.node, ">=20.3");
  assert.deepEqual(lock.packages[""].engines, pkg.engines);
  const docs = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(docs, /node\.js 20\.3 or newer/);
  assert.match(docs, /Install \(Node ≥ 20\.3;/);
});

for (const version of ["18.0.0", "18.20.0", "20.0.0", "20.2.0"]) {
  test(`CLI rejects Node ${version} with a clear upgrade message`, () => {
    const result = runVersion(version);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `ccc requires Node.js 20.3 or newer; you are running ${version}. Upgrade Node.js and try again.\n`);
  });
}

for (const version of ["20.3.0", "20.10.0", "24.2.0"]) {
  test(`CLI accepts Node ${version} and loads its command implementation`, () => {
    const result = runVersion(version);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2, "network-free fetch usage reached the implementation");
    assert.match(result.stderr, /^usage: ccc fetch <memtree-url>/);
    assert.doesNotMatch(result.stderr, /requires Node/);
  });
}

test("unsupported Node is rejected before the implementation module is parsed", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccc-runtime-bootstrap-"));
  try {
    const entry = join(dir, "cli.mjs");
    writeFileSync(entry, readFileSync(cli));
    writeFileSync(join(dir, "cli-main.js"), "this is intentionally invalid JavaScript !!!");
    const result = runVersion("20.2.0", pathToFileURL(entry));
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "ccc requires Node.js 20.3 or newer; you are running 20.2.0. Upgrade Node.js and try again.\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
