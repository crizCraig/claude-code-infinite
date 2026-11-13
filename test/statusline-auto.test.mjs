// ccc's status line on by default (statusline-auto.ts): installed when there is none,
// wrapped (and said, with the undo) when the user has one, skipped and said whenever
// wrapping could break it, and only ever once per config dir.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUTO_MARKER, autoInstallStatusline, onPath } from "../dist/statusline-auto.js";
import { STATUSLINE_COMMAND, uninstallStatusline } from "../dist/statusline.js";

const OWN = { type: "command", command: "input=$(cat); echo mine", padding: 0 };
const unix = { platform: "darwin", cccOnPath: () => true, env: {} };

function setup(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-statusline-auto-"));
  const file = path.join(dir, "settings.json");
  if (settings !== undefined) {
    fs.writeFileSync(file, typeof settings === "string" ? settings : JSON.stringify(settings));
  }
  const paths = { settings: file, saved: path.join(dir, "statusline-aaaaaaaaaaaa.json") };
  return { dir, file, paths, options: { ...unix, markerDir: path.join(dir, "ccc") } };
}

const read = (file) => JSON.parse(fs.readFileSync(file, "utf-8"));
const backups = (dir) => fs.readdirSync(dir).filter((n) => n.includes(".ccc-backup-"));

test("no status line: ccc's is installed, once", () => {
  const { file, paths, options } = setup({ model: "opus" });
  const notice = autoInstallStatusline(paths, options);
  assert.match(notice, /added this session's MemTree link/);
  assert.match(notice, /Undo: ccc statusline uninstall\./);
  assert.equal(read(file).statusLine.command, STATUSLINE_COMMAND);
  assert.equal(read(file).model, "opus");
  assert.equal(autoInstallStatusline(paths, options), undefined, "never twice");
});

test("no settings file at all: installed", () => {
  const { file, paths, options } = setup();
  assert.ok(autoInstallStatusline(paths, options));
  assert.equal(read(file).statusLine.command, STATUSLINE_COMMAND);
});

test("the user's own status line is wrapped, backed up, said once; uninstall stays off", () => {
  const { dir, file, paths, options } = setup({ statusLine: OWN });
  const notice = autoInstallStatusline(paths, options);
  assert.match(notice, /after your status line, which still runs first/);
  assert.match(notice, /Undo: ccc statusline uninstall\./);
  assert.equal(read(file).statusLine.command, STATUSLINE_COMMAND);
  assert.equal(read(file).statusLine.padding, 0, "its options stay");
  assert.equal(read(paths.saved).statusLine.command, OWN.command);
  assert.equal(backups(dir).length, 1, "settings.json backed up first");
  assert.ok(uninstallStatusline(paths).ok);
  assert.deepEqual(read(file).statusLine, OWN);
  assert.equal(autoInstallStatusline(paths, options), undefined, "an uninstall is not undone");
  assert.deepEqual(read(file).statusLine, OWN);
});

for (const [name, settings, why] of [
  ["invalid JSON", "{ not json", /is not valid JSON/],
  ["a statusLine that is not a command", { statusLine: { type: "static", text: "hi" } },
    /your statusLine is not a command/],
]) {
  test(`skipped and said: ${name}`, () => {
    const { dir, file, paths, options } = setup(settings);
    const before = fs.readFileSync(file, "utf-8");
    const notice = autoInstallStatusline(paths, options);
    assert.match(notice, /left your status line unchanged/);
    assert.match(notice, why);
    assert.match(notice, /ccc statusline install/);
    assert.equal(fs.readFileSync(file, "utf-8"), before, "untouched");
    assert.equal(backups(dir).length, 0);
    assert.equal(autoInstallStatusline(paths, options), undefined, "said once");
  });
}

test("installed and uninstalled with an older ccc (backups, no saved original): stays off", () => {
  const { dir, file, paths, options } = setup({ statusLine: OWN });
  fs.writeFileSync(path.join(dir, "settings.json.ccc-backup-2026-11-12T00-00-00-000Z"), "{}");
  assert.equal(autoInstallStatusline(paths, options), undefined);
  assert.deepEqual(read(file).statusLine, OWN);
});

test("skipped and said when ccc is not on PATH (the status line would print nothing)", () => {
  const { file, paths, options } = setup({ statusLine: OWN });
  const notice = autoInstallStatusline(paths, { ...options, cccOnPath: () => false });
  assert.match(notice, /`ccc` is not on PATH/);
  assert.deepEqual(read(file).statusLine, OWN);
});

test("already showing the link, Windows, or CCC_STATUSLINE_AUTO=0: nothing changes", () => {
  const ours = setup({ statusLine: { type: "command", command: "npx ccc statusline" } });
  assert.equal(autoInstallStatusline(ours.paths, ours.options), undefined);
  assert.equal(read(ours.file).statusLine.command, "npx ccc statusline");
  const win = setup({ statusLine: OWN });
  assert.equal(autoInstallStatusline(win.paths, { ...win.options, platform: "win32" }), undefined);
  assert.deepEqual(read(win.file).statusLine, OWN);
  assert.ok(fs.existsSync(path.join(win.options.markerDir, AUTO_MARKER)));
  const off = setup({ statusLine: OWN });
  assert.equal(autoInstallStatusline(off.paths,
    { ...off.options, env: { CCC_STATUSLINE_AUTO: "0" } }), undefined);
  assert.deepEqual(read(off.file).statusLine, OWN);
  assert.ok(!fs.existsSync(path.join(off.options.markerDir, AUTO_MARKER)), "not recorded");
});

test("PATH search finds an executable and ignores a missing one",
  { skip: process.platform === "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-path-"));
    fs.writeFileSync(path.join(dir, "ccc"), "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(onPath("ccc", { PATH: `/nonexistent${path.delimiter}${dir}` }), true);
    assert.equal(onPath("ccc", { PATH: "/nonexistent" }), false);
    assert.equal(onPath("ccc", {}), false);
  });
