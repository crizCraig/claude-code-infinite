// Finding Claude Code however it was installed (claude-locate.ts), plus a real
// launch of the shapes Windows installs leave behind: npm's claude.cmd shim on
// PATH and the native installer's claude.exe in %USERPROFILE%\.local\bin.
import test from "node:test";
import { installNpmClaude, npmShimText } from "./fixtures/npm-claude.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeInvocation, spawnClaudeSync } from "../dist/claude-process.js";
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
  findPathExecutable,
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

function npmShimFiles(shim) {
  return [shim, W.join(W.dirname(shim), "node_modules", "@anthropic-ai", "claude-code", "cli.js")];
}

const globalTarget = W.join("node_modules", "@anthropic-ai", "claude-code", "cli.js");
function readNpmFile(file) {
  return file.endsWith(".cmd") ? npmShimText(globalTarget) : "";
}

function locateWin(files, extra = {}) {
  return locateClaude({
    platform: "win32", env: WIN_ENV, homedir: "C:\\Users\\ada",
    readFile: readNpmFile,
    isExecutable: fakeFs(files, "win32"), registryPath: () => [], listDir: () => [], ...extra,
  });
}

test("Windows on PATH: spawn the resolved program, never a bare name", () => {
  const shim = "C:\\Program Files\\nodejs\\claude.cmd";
  assert.deepEqual(locateWin(npmShimFiles(shim)), { command: shim, source: "path" });
  assert.equal(locateWin(["claude.exe", ...npmShimFiles(shim)], { env: { ...WIN_ENV, Path: ".;" + WIN_ENV.Path } }).command, shim);
  // A later desktop exe on PATH changes nothing: the first resolved CLI still wins.
  const desktop = "C:\\Users\\ada\\AppData\\Local\\AnthropicClaude";
  const desktopLater = locateWin([...npmShimFiles(shim), W.join(desktop, "claude.exe")], {
    env: { ...WIN_ENV, Path: WIN_ENV.Path + ";" + desktop },
  });
  assert.deepEqual(desktopLater, { command: shim, source: "path" });
  assert.deepEqual(locateWin(["C:\\Windows\\system32\\CLAUDE.EXE"]), { command: "C:\\Windows\\system32\\claude.exe", source: "path" });
  // An unrelated extensionless file is not an installed Windows CLI.
  assert.equal(locateWin(["C:\\Program Files\\nodejs\\claude"]), null);
});

// Generated with cmd-shim 9, @zkochan/cmd-shim 9 (pnpm) and 3 (Yarn Classic).
// Berry's makePathWrapper embeds the actual absolute Node and entry paths.
const formats = [
  ["npm9", ".cmd"], ["npm9", ".bat"], ["npm9", ".ps1"], ["npm9", ""],
  ["pnpm", ".cmd"], ["pnpm", ".ps1"], ["pnpm", ""],
  ["classic", ".cmd"], ["classic", ""], ["berry", ".cmd"], ["berry", ""],
];

function shimText(format, ext, entry) {
  if (format === "berry") {
    const node = W.join(W.dirname(entry), "node.exe");
    return ext ? `@goto #_undefined_# 2>NUL || @title %COMSPEC% & @setlocal & @"${node}" "${entry}" %*` :
      `#!/bin/sh\nexec "${node}" '${entry}' "$@"\n`;
  }
  return fs.readFileSync(new URL(`./fixtures/windows-shims/${format}/claude${ext === ".bat" ? ".cmd" : ext}`, import.meta.url), "utf8");
}

const refusal = /unsupported.*wrapper.*install Claude Code with npm.*native installer.*CCC_CLAUDE_PATH.*claude\.exe.*JavaScript/i;

test("Windows recognizes generated shims and uses only the selected target and Node", () => {
  const dir = "D:\\bin";
  const entry = W.join(dir, "pkg", "cli.mjs");
  const node = W.join(dir, "node.exe");
  for (const [format, ext] of formats) {
    const shim = W.join(dir, "claude" + ext);
    const readFile = () => shimText(format, ext, entry);
    for (const adjacent of [false, true]) {
      const files = [shim, entry, ...(adjacent ? [node] : [])];
      const found = locateWin(files, { env: { Path: dir }, readFile });
      assert.equal(found?.command, shim, format + ext);
      const args = ["--resume", "a & b"];
      const job = claudeInvocation(shim, args, "win32", readFile, fakeFs(files, "win32"));
      assert.equal(job.command, adjacent && format !== "berry" ? node : process.execPath);
      assert.deepEqual(job.args, [entry, ...args]);
    }
  }
});

test("Windows refuses custom batch wrappers, including modified package-manager shims", () => {
  const dir = "D:\\bin";
  const stock = npmShimText(globalTarget);
  for (const ext of [".bat", ".cmd"]) {
    const wrapper = W.join(dir, "claude" + ext);
    for (const body of ['@node "%~dp0custom.cjs" %*', stock.replace("SETLOCAL", "SETLOCAL\nSET CUSTOM=1"),
      stock.replace("%*", "--custom %*"), stock + "@echo finished\r\n"]) {
      const files = [wrapper, W.join(dir, globalTarget), "D:\\native\\claude.exe"];
      assert.throws(() => locateWin(files, { env: { Path: dir + ";D:\\native" }, readFile: () => body }), refusal);
      assert.throws(() => claudeInvocation(wrapper, [], "win32", () => body, fakeFs(files, "win32")), refusal);
    }
  }
});

test("Windows skips an orphaned shim without a manifest in this or a later PATH directory", () => {
  const dir = "C:\\wrappers";
  const shim = W.join(dir, "claude.cmd");
  const readFile = file => {
    if (file !== shim) throw Object.assign(new Error("no manifest"), { code: "ENOENT" });
    return npmShimText(globalTarget);
  };
  for (const exe of [W.join(dir, "claude.exe"), "D:\\native\\claude.exe"]) {
    assert.equal(locateWin([shim, exe], { env: { Path: dir + ";D:\\native", PATHEXT: ".CMD;.EXE" }, readFile })?.command, exe);
  }
});

test("Yarn Classic global bin follows its generated shim in node_modules/.bin", () => {
  const shim = "C:\\yarn\\bin\\claude.cmd";
  const inner = W.resolve(W.dirname(shim), "../global/node_modules/.bin/claude.cmd");
  const entry = W.join(W.dirname(inner), "pkg", "cli.mjs");
  const files = new Map([[shim, '@"%~dp0\\..\\global\\node_modules\\.bin\\claude.cmd"   %*'],
    [inner, shimText("classic", ".cmd", entry)], [entry, ""]]);
  const args = ["--resume", "session"];
  const job = claudeInvocation(shim, args, "win32", f => files.get(f), f => files.has(f));
  assert.deepEqual(job, { command: process.execPath, args: [entry, ...args] });
});

test("Windows follows the extensionless Yarn Classic global shim and skips a missing inner target", () => {
  const dir = "C:\\yarn\\bin";
  const outer = W.join(dir, "claude");
  const inner = W.resolve(dir, "../global/node_modules/.bin/claude");
  const entry = W.join(W.dirname(inner), "pkg", "cli.mjs");
  const classic = shimText("classic", "", entry);
  const files = new Map([[outer, classic.replaceAll("$basedir/node", "$basedir//bin/sh")
    .replace("  node ", "  /bin/sh ").replaceAll("pkg/cli.mjs", "../global/node_modules/.bin/claude")],
    [inner, classic], [entry, ""]]);
  const readFile = f => files.get(f);
  const args = ["--resume", "session"];
  assert.deepEqual(claudeInvocation(outer, args, "win32", readFile, f => files.has(f)),
    { command: process.execPath, args: [entry, ...args] });
  files.delete(entry);
  assert.equal(locateWin([...files.keys()], { env: { Path: dir }, readFile }), null);
});

test("Generated native shims launch the absolute executable without an interpreter", () => {
  const dir = "C:\\Native Tools";
  const entry = W.join(dir, "pkg", "claude.exe");
  const args = ["--resume", "session"];
  for (const [ext, body] of [
    [".cmd", '@SETLOCAL\n@"%~dp0\\pkg\\claude.exe"   %*'], // pnpm
    [".cmd", '@"%~dp0\\pkg\\claude.exe"   %*'], // Classic
    [".cmd", `@goto #_undefined_# 2>NUL || @title %COMSPEC% & @setlocal & @"${entry}"  %*`],
    ["", `#!/bin/sh\nexec "${entry}"  "$@"\n`], // Berry
  ]) {
    const shim = W.join(dir, "claude" + ext);
    assert.deepEqual(claudeInvocation(shim, args, "win32", () => body, fakeFs([entry, shim], "win32")),
      { command: entry, args });
  }
});

test("Windows override selects an existing absolute executable or JS entry", () => {
  for (const entry of ["D:\\custom\\cli.cjs", "D:\\custom\\claude.exe"]) {
    const env = { ...WIN_ENV, CCC_CLAUDE_PATH: entry };
    assert.equal(locateWin([entry, ...npmShimFiles(W.join(WIN_ENV.APPDATA, "npm", "claude.cmd"))], { env })?.command, entry);
    assert.throws(() => locateWin([], { env }), /CCC_CLAUDE_PATH/);
  }
  for (const entry of ["claude.exe", "C:cli.js", "\\bin\\claude.exe", "D:\\custom.cmd"]) {
    assert.throws(() => locateWin([entry], { env: { ...WIN_ENV, CCC_CLAUDE_PATH: entry } }), /CCC_CLAUDE_PATH/);
  }
});

test("Windows project metadata resolves git.exe outside the project", () => {
  const env = { Path: ".;C:tools;\\tools;C:\\project;C:\\Git\\cmd" };
  const checked = [];
  const result = findPathExecutable("git.exe", "win32", env, "c:\\project", file => { checked.push(file); return true; });
  assert.deepEqual(checked, ["C:\\Git\\cmd\\git.exe"]);
  assert.equal(result, checked[0]);
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
  assert.equal(locateWin(npmShimFiles(npmShim)).source, "npm");
  assert.equal(locateWin(npmShimFiles(npmShim)).command, npmShim);
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
  assert.equal(locateWin(npmShimFiles("C:\\Program Files\\nodejs\\claude.cmd"), { registryPath }).source, "path");
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
    const locate = (files) => locateWin(files, { env, registryPath: () => [dir] });
    assert.equal(locate([`${dir}\\claude.exe`]), null, dir);
    // The real CLI later on PATH: by its full path, since `claude` would start the desktop app.
    const cli = "C:\\Program Files\\nodejs\\claude.cmd";
    assert.deepEqual(locate([`${dir}\\claude.exe`, ...npmShimFiles(cli)]),
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
// Real launches (Windows): the production launcher for each install shape
// ---------------------------------------------------------------------------

function tmpdir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccc-claude-")));
}

/** Run what locate found the way ccc does, with args that cmd.exe would mangle unescaped. */
function launch(location, env, outFile, cwd) {
  const args = ["--plugin-dir", "C:\\a dir\\x", "say \"hi\" & echo pwned", "100%"];
  const result = spawnClaudeSync(location.command, args, {
    cwd, env: { ...withClaudeOnPath(env, location), CLAUDE_OUT: outFile }, encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stderr}`);
  return { args, got: JSON.parse(fs.readFileSync(outFile, "utf8")) };
}

const RECORD_ARGS =
  "fs.writeFileSync(process.env.CLAUDE_OUT, JSON.stringify(process.argv.slice(2)))";

test("Windows: npm's claude.cmd shim on PATH launches, arguments intact", {
  skip: !isWindows && "Windows only",
}, () => {
  const dir = tmpdir();
  const npmDir = path.join(dir, "npm");
  fs.mkdirSync(npmDir);
  installNpmClaude(npmDir, "import fs from 'node:fs'; " + RECORD_ARGS);
  const env = { ...process.env, Path: npmDir };
  delete env.PATH;
  const location = locateClaude({ env, registryPath: () => [] });
  assert.deepEqual(location, { command: path.join(npmDir, "claude.cmd"), source: "path" });
  const { args, got } = launch(location, env, path.join(dir, "out.json"));
  assert.deepEqual(got, args);
});

const prompts = ["first paragraph\n\nsecond paragraph\r\nthird line", "a b c ".repeat(1000)];
const literalArgs = ['a"&echo unexpected', '5" > out', "|", "^", "x^y", "%PATH%", "100%", "!"];

for (const [format, ext] of formats) {
  test(`Windows launches ${format} claude${ext} with literal multiline and long prompts`, { skip: !isWindows }, t => {
    const root = tmpdir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, "package manager");
    const entry = path.join(dir, "pkg", "cli.mjs");
    const cwd = path.join(root, "project");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.mkdirSync(cwd);
    fs.writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    const shim = path.join(dir, "claude" + ext);
    fs.writeFileSync(shim, shimText(format, ext, entry));
    fs.writeFileSync(path.join(cwd, "node.cmd"), "@exit /b 42");
    const env = { ...process.env, Path: dir };
    delete env.PATH;
    const found = locateClaude({ env, registryPath: () => [] });
    assert.equal(found?.command, shim);
    for (const prompt of prompts) {
      const args = ["-p", prompt, ...literalArgs];
      const result = spawnClaudeSync(found.command, args, { env, cwd, encoding: "utf8" });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, JSON.stringify(args));
    }
    assert.deepEqual(fs.readdirSync(cwd), ["node.cmd"]);
  });
}

test("Windows skips a stale shim and launches the later executable for startup and resume", { skip: !isWindows }, t => {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "native");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, "claude.cmd"), npmShimText(globalTarget));
  const exe = path.join(bin, "claude.exe");
  try { fs.linkSync(process.execPath, exe); } catch { fs.copyFileSync(process.execPath, exe); }
  const env = { ...process.env, Path: [root, bin].join(";") };
  delete env.PATH;
  for (const args of [["-p", prompts[0]], ["--resume", "session"]]) {
    const found = locateClaude({ env });
    assert.equal(found?.command, exe);
    const result = spawnClaudeSync(found.command, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", ...args],
      { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
  }
});

test("Windows CLI refuses a custom .bat with install and override instructions before running it", { skip: !isWindows }, t => {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude.bat"), "@echo ran>marker");
  const env = { ...process.env, Path: bin, CCC_NO_UPDATE_CHECK: "1", CCC_NO_DIAGNOSTICS: "1" };
  delete env.PATH;
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "--version"], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr.trim(), refusal);
  assert.doesNotMatch(result.stderr.trim(), /\n/);
  assert.equal(fs.existsSync(path.join(root, "marker")), false);
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
  const record = "const fs = require('node:fs'); " + RECORD_ARGS.replace("slice(2)", "slice(1)"); // `node -e`: no script path
  const result = spawnClaudeSync(location.command, ["-e", record, "--", "a b", "c&d"], {
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

test("Windows npm global and local shims launch the declared bin directly", () => {
  const args = ["--resume", "a & b", 'say "hello"'];
  const modules = "C:\\Tools With Spaces\\node_modules";
  const pkg = W.join(modules, "@anthropic-ai", "claude-code");
  for (const shim of [W.join(W.dirname(modules), "claude.cmd"), W.join(modules, ".bin", "claude.cmd")]) {
    for (const bin of ["./cli.js", "./bin/claude.exe"]) {
      const entry = W.join(pkg, bin);
      const job = claudeInvocation(shim, args, "win32", () => npmShimText(W.relative(W.dirname(shim), entry)),
        fakeFs([shim, entry], "win32"));
      assert.deepEqual(job, bin.endsWith(".js")
        ? { command: process.execPath, args: [entry, ...args] }
        : { command: entry, args });
    }
  }
  assert.throws(() => claudeInvocation("claude.cmd", args, "win32"));
  assert.deepEqual(claudeInvocation("C:\\Tools\\claude.exe", args, "win32"),
    { command: "C:\\Tools\\claude.exe", args });
});
