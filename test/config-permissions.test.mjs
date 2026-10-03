import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.js resolves the home directory when it loads, so point HOME first.
const home = mkdtempSync(join(tmpdir(), "ccc-config-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { getPolychatApiKey, setPolychatApiKey } = await import("../dist/config.js");
const dir = join(home, ".claude-code-infinite");
const file = join(dir, "config.json");
const mode = (path) => statSync(path).mode & 0o777;

test("saved keys are readable only by their owner", { skip: process.platform === "win32" }, () => {
  setPolychatApiKey("sk-secret");
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(file), 0o600);
});

test("an existing world-readable config is tightened when read", {
  skip: process.platform === "win32",
}, () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ polychatApiKey: "sk-old" }));
  chmodSync(file, 0o644);
  chmodSync(dir, 0o755);
  assert.equal(getPolychatApiKey(), "sk-old");
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(file), 0o600);
});
