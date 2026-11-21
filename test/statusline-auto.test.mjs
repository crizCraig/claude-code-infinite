// ccc's status line on by default (statusline-auto.ts): installed when there is none,
// wrapped (and said, with the undo) when the user has one, skipped and said whenever
// wrapping could break it, and only ever once per config dir.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import { AUTO_MARKER, autoInstallStatusline, onPath, prepareSessionStatusline } from "../dist/statusline-auto.js";
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
  return { dir, file, paths, options: { ...unix, cwd: dir, managedDir: path.join(dir, "policy"), markerDir: path.join(dir, "ccc") } };
}

const read = (file) => JSON.parse(fs.readFileSync(file, "utf-8"));
const backups = (dir) => fs.readdirSync(dir).filter((n) => n.includes(".ccc-backup-"));

test("no status line: ccc's is installed, once", () => {
  const { file, paths, options } = setup({ model: "opus" });
  const session = prepareSessionStatusline(true, paths, options);
  assert.equal(session.showsLink, true);
  const notice = session.text;
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
  assert.equal(prepareSessionStatusline(true, paths, options).showsLink, false);
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
  const windows = prepareSessionStatusline(true, win.paths, { ...win.options, platform: "win32" });
  assert.equal(windows.text, undefined);
  assert.equal(windows.showsLink, false);
  assert.deepEqual(read(win.file).statusLine, OWN);
  assert.ok(fs.existsSync(path.join(win.options.markerDir, AUTO_MARKER)));
  const off = setup({ statusLine: OWN });
  const disabled = prepareSessionStatusline(true, off.paths,
    { ...off.options, env: { CCC_STATUSLINE_AUTO: "0", CCC_STATUSLINE_REFRESH: "1" } });
  assert.deepEqual(disabled, { text: undefined, showsLink: false, refresh: true });
  assert.deepEqual(read(off.file).statusLine, OWN);
  assert.ok(!fs.existsSync(path.join(off.options.markerDir, AUTO_MARKER)), "not recorded");
});

test("only an interactive session can show a configured link, even with auto-install disabled", () => {
  const { paths, options } = setup({ statusLine: { type: "command", command: STATUSLINE_COMMAND } });
  const disabled = { ...options, env: { CCC_STATUSLINE_AUTO: "0" } };
  const interactive = prepareSessionStatusline(true, paths, disabled);
  assert.equal(interactive.showsLink, true);
  assert.deepEqual(prepareSessionStatusline(false, paths, disabled),
    { text: undefined, showsLink: false, refresh: true });
  fs.writeFileSync(paths.settings, JSON.stringify({ statusLine: OWN }));
  assert.equal(interactive.showsLink, false, "a replacement takes effect in the running session");
  assert.equal(prepareSessionStatusline(true, paths, disabled).showsLink, false);
});

const CCC = { type: "command", command: STATUSLINE_COMMAND };

function put(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings));
}

test("Stop uses the highest settings scope that configures the status line", () => {
  const { dir, paths, options } = setup({ statusLine: CCC });
  const project = path.join(dir, ".claude", "settings.json");
  const local = path.join(dir, ".claude", "settings.local.json");
  const policy = path.join(options.managedDir, "managed-settings.json");
  const dropIn = path.join(options.managedDir, "managed-settings.d", "20-status.json");
  const check = () => prepareSessionStatusline(true, paths, options).showsLink;
  put(project, { statusLine: OWN });
  assert.equal(check(), false, "project overrides user");
  put(local, { model: "opus" });
  assert.equal(check(), false, "unrelated local settings inherit the project command");
  put(local, { statusLine: CCC });
  assert.equal(check(), true, "local overrides project");
  options.claudeArgs = ["--setting-sources", "project"];
  assert.equal(check(), false, "excluded user and local scopes");
  options.claudeArgs = ["--settings", JSON.stringify({ statusLine: OWN })];
  assert.equal(check(), false, "session settings override local");
  put(policy, { statusLine: CCC });
  assert.equal(check(), true, "managed overrides session settings");
  put(dropIn, { statusLine: OWN });
  assert.equal(check(), false, "managed drop-ins override the base policy");
});

test("running Stop decision follows install, replacement, uninstall and policy edits", (t) => {
  const { dir, paths, options } = setup({});
  options.env = { CCC_STATUSLINE_AUTO: "0" };
  const session = prepareSessionStatusline(true, paths, options);
  const local = path.join(dir, ".claude", "settings.local.json");
  const dropIn = path.join(options.managedDir, "managed-settings.d", "10-team.json");
  assert.equal(session.showsLink, false);
  put(local, { statusLine: CCC });
  assert.equal(session.showsLink, true, "late install");
  const reads = t.mock.method(fs, "readFileSync");
  syncBuiltinESMExports();
  t.after(() => { reads.mock.restore(); syncBuiltinESMExports(); });
  assert.equal(session.showsLink, true);
  assert.equal(reads.mock.callCount(), 0, "unchanged settings files are not reread");
  put(dropIn, { statusLine: OWN });
  assert.equal(session.showsLink, false, "new policy file");
  assert.ok(reads.mock.callCount() > 0, "the changed settings were read");
  put(dropIn, { statusLine: CCC });
  assert.equal(session.showsLink, true, "existing policy file changed");
  fs.unlinkSync(dropIn);
  put(local, { statusLine: OWN });
  assert.equal(session.showsLink, false, "replacement");
  put(paths.settings, { statusLine: CCC });
  fs.unlinkSync(local);
  assert.equal(session.showsLink, true, "removed override");
  fs.unlinkSync(paths.settings);
  assert.equal(session.showsLink, false, "uninstall");
});

test("an unreadable configuration, computed policy or disabled status line keeps the fallback", () => {
  const { dir, paths, options } = setup({ statusLine: CCC });
  const session = prepareSessionStatusline(true, paths, options);
  const policy = path.join(options.managedDir, "managed-settings.json");
  put(policy, { disableAllHooks: true, statusLine: CCC });
  assert.equal(session.showsLink, false);
  put(policy, { allowManagedHooksOnly: true });
  assert.equal(session.showsLink, false);
  put(policy, { allowManagedHooksOnly: true, statusLine: CCC });
  assert.equal(session.showsLink, true);
  put(policy, { policyHelper: "/policy/helper" });
  assert.equal(session.showsLink, false);
  fs.writeFileSync(policy, "{");
  assert.equal(session.showsLink, false);
  fs.unlinkSync(policy);
  put(path.join(dir, "remote-settings.json"), { statusLine: OWN });
  assert.equal(session.showsLink, false);
});

test("Stop keeps the fallback for a stale ccc on PATH or a mere mention of its command", () => {
  const { dir, paths, options } = setup({ statusLine: CCC });
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "ccc"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  delete options.cccOnPath;
  options.env = { PATH: bin, CCC_STATUSLINE_AUTO: "0" };
  assert.equal(prepareSessionStatusline(true, paths, options).showsLink, false);
  put(paths.settings, { statusLine: { type: "command", command: "echo custom # ccc statusline" } });
  assert.equal(prepareSessionStatusline(true, paths, { ...options, cccOnPath: () => true }).showsLink, false);
});

test("the status-line executable must resolve to this installation", { skip: process.platform === "win32" }, () => {
  const { dir, paths, options } = setup({ statusLine: CCC });
  delete options.cccOnPath;
  options.env = { PATH: dir, CCC_STATUSLINE_AUTO: "0" };
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const bin = path.join(dir, "ccc");
  fs.symlinkSync(cli, bin);
  const session = prepareSessionStatusline(true, paths, options);
  assert.equal(session.showsLink, true);
  fs.unlinkSync(bin);
  fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(session.showsLink, false);
  put(paths.settings, { statusLine: { type: "command", command: `"${cli}" statusline` } });
  assert.equal(session.showsLink, true);
});

test("PATH search finds an executable and ignores a missing one",
  { skip: process.platform === "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-path-"));
    fs.writeFileSync(path.join(dir, "ccc"), "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(onPath("ccc", { PATH: `/nonexistent${path.delimiter}${dir}` }), true);
    assert.equal(onPath("ccc", { PATH: "/nonexistent" }), false);
    assert.equal(onPath("ccc", {}), false);
    const dirOnly = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-path-"));
    fs.mkdirSync(path.join(dirOnly, "ccc"));
    assert.equal(onPath("ccc", { PATH: dirOnly }), false, "a directory named ccc is no command");
  });
