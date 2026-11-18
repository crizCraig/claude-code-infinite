import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.js resolves the home directory when it loads, so point HOME first.
const home = mkdtempSync(join(tmpdir(), "ccc-config-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { getPolychatApiKey, getStagingPolychatApiKey, getLocalPolychatApiKey, setPolychatApiKey,
  setLocalPolychatApiKey, setStagingPolychatApiKey } = await import("../dist/config.js");
const dir = join(home, ".claude-code-infinite");
const file = join(dir, "config.json");
const mode = (path) => statSync(path).mode & 0o777;

test("saved keys are readable only by their owner", {
  skip: process.platform === "win32" && "Windows has no POSIX mode bits",
}, () => {
  setPolychatApiKey("sk-" + "1".repeat(32));
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(file), 0o600);
});

test("an existing world-readable config is tightened when read", {
  skip: process.platform === "win32" && "Windows has no POSIX mode bits",
}, () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ polychatApiKey: "sk-00000000000000000000000000000000" }));
  chmodSync(file, 0o644);
  chmodSync(dir, 0o755);
  assert.equal(getPolychatApiKey(), "sk-00000000000000000000000000000000");
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(file), 0o600);
});

test("all key setters reject malformed input and leave the previous config intact", () => {
  const valid = "sk-" + "1".repeat(32);
  setPolychatApiKey(valid);
  const before = readFileSync(file, "utf8");
  for (const set of [setPolychatApiKey, setLocalPolychatApiKey, setStagingPolychatApiKey]) {
    assert.throws(() => set("private pasted text"), /MemTree/);
    assert.equal(readFileSync(file, "utf8"), before);
  }
});

test("new keys are trimmed in every environment and unrelated saved keys survive", () => {
  const valid = "sk-" + "a".repeat(32);
  for (const [set, get] of [[setPolychatApiKey, getPolychatApiKey],
    [setLocalPolychatApiKey, getLocalPolychatApiKey], [setStagingPolychatApiKey, getStagingPolychatApiKey]]) {
    set(" \t" + valid + "\n");
    assert.equal(get(), valid);
  }
  writeFileSync(file, JSON.stringify({ localPolychatApiKey: "old saved value", updateCheck: false }));
  setStagingPolychatApiKey(valid);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).localPolychatApiKey, "old saved value");
});

test("repeated reads return the original legacy key and warn only once per process", t => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ polychatApiKey: "legacy-credential" }));
  const warnings = t.mock.method(console, "warn", () => {});
  assert.equal(getPolychatApiKey(), "legacy-credential");
  assert.equal(getPolychatApiKey(), "legacy-credential");
  assert.equal(warnings.mock.callCount(), 1);
  assert.doesNotMatch(warnings.mock.calls[0].arguments.join(" "), /legacy-credential/);
});
