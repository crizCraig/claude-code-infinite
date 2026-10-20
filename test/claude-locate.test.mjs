// Finding Claude Code however it was installed (claude-locate.ts), plus a real
// launch of the shapes Windows installs leave behind: npm's claude.cmd shim on
// PATH and the native installer's claude.exe in %USERPROFILE%\.local\bin.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crossSpawn from "cross-spawn";
import {
  CLAUDE_FOUND,
  CLAUDE_SOURCES,
  claudeDesktopInstalled,
  claudeDesktopOnlyText,
  claudeMissingText,
  cwdHintText,
  expandWindowsVars,
  locateClaude,
  parseRegQueryPath,
  withClaudeOnPath,
} from "../dist/claude-locate.js";
import { CLAUDE_FOUND as SCHEMA_FOUND, sanitizeContext } from "../dist/diagnostics-schema.js";

const isWindows = process.platform === "win32";
const W = path.win32;

/** A fake filesystem: the set of runnable files (Windows paths compare case-insensitively). */
function fakeFs(files, platform) {
  const set = new Set(files.map((f) => (platform === "win32" ? f.toLowerCase() : f)));
  return (file) => set.has(platform === "win32" ? file.toLowerCase() : file);
}

const WIN_ENV = {
  Path: "C:\\Windows\\system32;C:\\Program Files\\nodejs",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  USERPROFILE: "C:\\Users\\ada",
  APPDATA: "C:\\Users\\ada\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
};

function locateWin(files, extra = {}) {
  return locateClaude({
    platform: "win32", env: WIN_ENV, homedir: "C:\\Users\\ada",
    isExecutable: fakeFs(files, "win32"), registryPath: () => [], listDir: () => [], ...extra,
  });
}

test("on PATH: spawned by name, as before (claude.cmd or claude.exe both count)", () => {
  const shim = "C:\\Program Files\\nodejs\\claude.cmd";
  assert.deepEqual(locateWin([shim]), { command: "claude", source: "path" });
  // A later desktop exe on PATH changes nothing: the first claude is still spawned by name.
  const desktopLater = locateClaude({
    platform: "win32", env: { ...WIN_ENV, Path: `${WIN_ENV.Path};C:\\Users\\ada\\AppData\\Local\\AnthropicClaude` },
    homedir: "C:\\Users\\ada", registryPath: () => [], listDir: () => [],
    isExecutable: fakeFs([shim, "C:\\Users\\ada\\AppData\\Local\\AnthropicClaude\\claude.exe"], "win32"),
  });
  assert.deepEqual(desktopLater, { command: "claude", source: "path" });
  assert.deepEqual(locateWin(["C:\\Windows\\system32\\CLAUDE.EXE"]), { command: "claude", source: "path" });
  // An extensionless `claude` (npm's script for Git Bash) is not something cmd can run.
  assert.equal(locateWin(["C:\\Program Files\\nodejs\\claude"]), null);
});

test("Windows: the native installer's claude.exe off PATH is found and its folder added", () => {
  const exe = "C:\\Users\\ada\\.local\\bin\\claude.exe";
  const found = locateWin([exe]);
  assert.deepEqual(found, { command: exe, source: "native", dir: "C:\\Users\\ada\\.local\\bin" });
  const env = withClaudeOnPath(WIN_ENV, found, "win32");
  assert.equal(env.Path, `C:\\Users\\ada\\.local\\bin;${WIN_ENV.Path}`);
  assert.equal(env.PATH, undefined, "Windows' own Path key, not a second one");
});

test("Windows: npm's global claude.cmd and winget's link are found off PATH", () => {
  const npmShim = "C:\\Users\\ada\\AppData\\Roaming\\npm\\claude.cmd";
  assert.equal(locateWin([npmShim]).source, "npm");
  assert.equal(locateWin([npmShim]).command, npmShim);
  const link = "C:\\Users\\ada\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe";
  assert.equal(locateWin([link]).source, "winget");
  const pkgDir = "C:\\Users\\ada\\AppData\\Local\\Microsoft\\WinGet\\Packages";
  const pkg = `${pkgDir}\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe`;
  const found = locateWin([`${pkg}\\claude.exe`], {
    listDir: (dir) => (dir === pkgDir ? ["Other.App_x", W.basename(pkg)] : []),
  });
  assert.equal(found.source, "winget");
  assert.equal(found.command, `${pkg}\\claude.exe`);
});

test("Windows: installed since this terminal opened: the registry PATH has it", () => {
  const custom = "D:\\tools\\claude\\claude.exe";
  const found = locateWin([custom], {
    registryPath: () => ["%USERPROFILE%\\.local\\bin;D:\\tools\\claude", "C:\\Windows"],
  });
  assert.deepEqual(found, { command: custom, source: "registry-path", dir: "D:\\tools\\claude" });
});

test("Windows: the registry is read only when no installer folder has claude", () => {
  let reads = 0;
  const registryPath = () => { reads += 1; return ["D:\\tools"]; };
  const exe = "C:\\Users\\ada\\.local\\bin\\claude.exe";
  assert.equal(locateWin([exe, "D:\\tools\\claude.exe"], { registryPath }).source, "native");
  assert.equal(reads, 0, "two reg.exe spawns saved");
  assert.equal(locateWin(["C:\\Program Files\\nodejs\\claude.cmd"], { registryPath }).source, "path");
  assert.equal(reads, 0);
  assert.equal(locateWin([], { registryPath }), null);
  assert.equal(reads, 1);
});

test("reg query output and %VAR% expansion", () => {
  const out = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    " +
    "%USERPROFILE%\\.local\\bin;C:\\x\r\n\r\n";
  assert.equal(parseRegQueryPath(out), "%USERPROFILE%\\.local\\bin;C:\\x");
  assert.equal(parseRegQueryPath("    Path    REG_SZ    C:\\y"), "C:\\y");
  assert.equal(parseRegQueryPath("ERROR: The system was unable to find"), null);
  assert.equal(expandWindowsVars("%userprofile%\\a;%NOPE%\\b", WIN_ENV), "C:\\Users\\ada\\a;%NOPE%\\b");
});

test("macOS/Linux: the native installer, the legacy local install and Homebrew off PATH", () => {
  const base = { platform: "linux", env: { PATH: "/usr/bin" }, homedir: "/home/ada" };
  const at = (file) => locateClaude({ ...base, isExecutable: fakeFs([file], "linux") });
  assert.deepEqual(at("/home/ada/.local/bin/claude"),
    { command: "/home/ada/.local/bin/claude", source: "native", dir: "/home/ada/.local/bin" });
  assert.equal(at("/home/ada/.claude/local/claude").source, "legacy-local");
  assert.equal(at("/opt/homebrew/bin/claude").source, "homebrew");
  assert.deepEqual(at("/usr/bin/claude"), { command: "claude", source: "path" });
  assert.equal(at("/nowhere/claude"), null);
});

test("not installed: the official install command for the OS, and the sign-in step", () => {
  const win = claudeMissingText("win32");
  assert.match(win, /irm https:\/\/claude\.ai\/install\.ps1 \| iex/);
  assert.match(win, /open a new terminal, run `claude` once to sign in/);
  assert.match(claudeMissingText("darwin"), /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
});

test("cwd tip: System32 and the home folder get one line; a project folder gets none", () => {
  const opts = { platform: "win32", env: { SystemRoot: "C:\\WINDOWS" }, homedir: "C:\\Users\\ada" };
  assert.match(cwdHintText("C:\\Windows\\System32", opts), /running in C:\\Windows\\System32\. Run it from your project folder/);
  assert.match(cwdHintText("c:\\windows\\system32\\", opts), /project folder/);
  assert.match(cwdHintText("C:\\Users\\ada", opts), /running in your home folder/);
  assert.equal(cwdHintText("C:\\Users\\ada\\code\\app", opts), null);
  const mac = { platform: "darwin", env: {}, homedir: "/Users/ada" };
  assert.match(cwdHintText("/Users/ada/", mac), /home folder/);
  assert.equal(cwdHintText("/Users/ada/src/app", mac), null);
  assert.equal(cwdHintText("C:\\Windows\\System32", mac), null);
  for (const line of [cwdHintText("C:\\Users\\ada", opts)]) assert.doesNotMatch(line, /\n/);
});

test("the diagnostics schema allows exactly the sources locate reports, plus desktop_only", () => {
  assert.deepEqual([...CLAUDE_FOUND], [...CLAUDE_SOURCES, "desktop_only"]);
  assert.deepEqual([...SCHEMA_FOUND], [...CLAUDE_FOUND]);
  assert.deepEqual(sanitizeContext({ claude_found: "desktop_only" }), { claude_found: "desktop_only" });
});

// ---------------------------------------------------------------------------
// The Claude desktop app: it is not the terminal CLI ccc runs
// ---------------------------------------------------------------------------

test("Windows: the desktop app's own claude.exe on PATH is not taken for the CLI", () => {
  const squirrel = "C:\\Users\\ada\\AppData\\Local\\AnthropicClaude";
  const store = "C:\\Program Files\\WindowsApps\\Claude_1.2.3.0_x64__pzs8sxrjxfjjc\\app";
  // A Store app's execution alias: the CLI's installers never put claude.exe there.
  const alias = "C:\\Users\\ada\\AppData\\Local\\Microsoft\\WindowsApps";
  for (const dir of [squirrel, `${squirrel}\\app-1.2.3`, store, alias,
    `${alias}\\Claude_pzs8sxrjxfjjc`]) {
    const env = { ...WIN_ENV, Path: `${dir};${WIN_ENV.Path}` };
    const locate = (files) => locateClaude({
      platform: "win32", env, homedir: "C:\\Users\\ada", isExecutable: fakeFs(files, "win32"),
      registryPath: () => [dir], listDir: () => [],
    });
    assert.equal(locate([`${dir}\\claude.exe`]), null, dir);
    // The real CLI later on PATH: by its full path, since `claude` would start the desktop app.
    const cli = "C:\\Program Files\\nodejs\\claude.cmd";
    assert.deepEqual(locate([`${dir}\\claude.exe`, cli]),
      { command: cli, source: "path", dir: "C:\\Program Files\\nodejs" });
    const exe = "C:\\Users\\ada\\.local\\bin\\claude.exe";
    assert.equal(locate([`${dir}\\claude.exe`, exe]).source, "native");
  }
});

test("desktop app installed, no CLI: detected per OS, never from the CLI's own folders", () => {
  const winOpts = (dirs) => ({
    platform: "win32", env: WIN_ENV, homedir: "C:\\Users\\ada",
    exists: fakeFs(dirs, "win32"),
  });
  const local = "C:\\Users\\ada\\AppData\\Local";
  assert.equal(claudeDesktopInstalled(winOpts([`${local}\\AnthropicClaude`])), true);
  assert.equal(claudeDesktopInstalled(winOpts([`${local}\\Packages\\Claude_pzs8sxrjxfjjc`])), true);
  // MCP guides have people create %APPDATA%\Claude by hand; it is not an install.
  assert.equal(claudeDesktopInstalled(winOpts(["C:\\Users\\ada\\AppData\\Roaming\\Claude"])), false);
  assert.equal(claudeDesktopInstalled(winOpts([
    "C:\\Users\\ada\\.claude", "C:\\Users\\ada\\.local\\bin",
  ])), false, "~/.claude is shared with the CLI");
  const mac = (dirs) => ({ platform: "darwin", env: {}, homedir: "/Users/ada", exists: fakeFs(dirs, "darwin") });
  assert.equal(claudeDesktopInstalled(mac(["/Applications/Claude.app"])), true);
  assert.equal(claudeDesktopInstalled(mac(["/Users/ada/Applications/Claude.app"])), true);
  assert.equal(claudeDesktopInstalled(mac(["/Users/ada/.claude"])), false);
  assert.equal(claudeDesktopInstalled({ platform: "linux", env: {}, homedir: "/home/ada",
    exists: () => true }), false);
});

test("desktop app only: one message naming the app and the terminal install", () => {
  const win = claudeDesktopOnlyText("win32");
  assert.match(win, /^Found the Claude desktop app, but ccc needs Claude Code in the terminal: /);
  assert.match(win, /install it with `irm https:\/\/claude\.ai\/install\.ps1 \| iex`/);
  assert.match(win, /run `claude` once to sign in/);
  assert.match(claudeDesktopOnlyText("darwin"),
    /`curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash`/);
});

// ---------------------------------------------------------------------------
// Real launches (Windows): what cross-spawn runs for each install shape
// ---------------------------------------------------------------------------

function tmpdir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccc-claude-")));
}

/** Run what locate found the way ccc does, with args that cmd.exe would mangle unescaped. */
function launch(location, env, outFile) {
  const args = ["--plugin-dir", "C:\\a dir\\x", "say \"hi\" & echo pwned", "100%"];
  const result = crossSpawn.sync(location.command, args, {
    env: { ...withClaudeOnPath(env, location), CLAUDE_OUT: outFile }, encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stderr}`);
  return { args, got: JSON.parse(fs.readFileSync(outFile, "utf8")) };
}

const RECORD_ARGS =
  "require('fs').writeFileSync(process.env.CLAUDE_OUT, JSON.stringify(process.argv.slice(2)))";

test("Windows: npm's claude.cmd shim on PATH launches, arguments intact", {
  skip: !isWindows && "Windows only",
}, () => {
  const dir = tmpdir();
  const npmDir = path.join(dir, "npm");
  fs.mkdirSync(npmDir);
  const js = path.join(dir, "fake-claude.js");
  fs.writeFileSync(js, `${RECORD_ARGS};\n`);
  // The shape of npm's cmd-shim for a bin.
  fs.writeFileSync(path.join(npmDir, "claude.cmd"),
    `@ECHO off\r\n"${process.execPath}" "${js}" %*\r\n`);
  const env = { ...process.env, Path: `${npmDir};${process.env.Path ?? process.env.PATH}` };
  delete env.PATH;
  const location = locateClaude({ env, registryPath: () => [] });
  assert.deepEqual(location, { command: "claude", source: "path" });
  const { args, got } = launch(location, env, path.join(dir, "out.json"));
  assert.deepEqual(got, args);
});

test("Windows: the native claude.exe in %USERPROFILE%\\.local\\bin, not on PATH, launches", {
  skip: !isWindows && "Windows only",
}, () => {
  const profile = tmpdir();
  const bin = path.join(profile, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  // A real executable named claude.exe: node.exe under that name, given its script with -e.
  const exe = path.join(bin, "claude.exe");
  try { fs.linkSync(process.execPath, exe); } catch { fs.copyFileSync(process.execPath, exe); }
  const env = {
    ...process.env, USERPROFILE: profile, APPDATA: path.join(profile, "Roaming"),
    LOCALAPPDATA: path.join(profile, "Local"),
  };
  const location = locateClaude({ env, homedir: profile, registryPath: () => [] });
  assert.equal(location?.source, "native", JSON.stringify(location));
  assert.equal(location.command.toLowerCase(), exe.toLowerCase());
  const out = path.join(profile, "out.json");
  const record = RECORD_ARGS.replace("slice(2)", "slice(1)"); // `node -e`: no script path
  const result = crossSpawn.sync(location.command, ["-e", record, "--", "a b", "c&d"], {
    env: { ...withClaudeOnPath(env, location), CLAUDE_OUT: out }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), ["a b", "c&d"]);
});

test("Windows: with no claude anywhere, locate says so (ccc then prints the install command)", {
  skip: !isWindows && "Windows only",
}, () => {
  const profile = tmpdir();
  const env = {
    Path: "C:\\Windows\\System32", PATHEXT: ".COM;.EXE;.BAT;.CMD", USERPROFILE: profile,
    APPDATA: path.join(profile, "R"), LOCALAPPDATA: path.join(profile, "L"),
  };
  assert.equal(locateClaude({ env, homedir: profile, registryPath: () => [] }), null);
});

test("Windows: only the desktop app's claude.exe (on PATH, real files): not launched, app detected", {
  skip: !isWindows && "Windows only",
}, () => {
  const profile = tmpdir();
  const local = path.join(profile, "Local");
  const app = path.join(local, "AnthropicClaude");
  fs.mkdirSync(app, { recursive: true });
  try { fs.linkSync(process.execPath, path.join(app, "claude.exe")); }
  catch { fs.copyFileSync(process.execPath, path.join(app, "claude.exe")); }
  const env = {
    Path: `${app};C:\\Windows\\System32`, PATHEXT: ".COM;.EXE;.BAT;.CMD", USERPROFILE: profile,
    APPDATA: path.join(profile, "Roaming"), LOCALAPPDATA: local,
  };
  assert.equal(locateClaude({ env, homedir: profile, registryPath: () => [] }), null);
  assert.equal(claudeDesktopInstalled({ env, homedir: profile }), true);
  assert.equal(claudeDesktopInstalled({
    env: { ...env, LOCALAPPDATA: path.join(profile, "none") }, homedir: profile,
  }), false);
});
