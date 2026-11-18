// Finding Claude Code however it was installed (claude-locate.ts), plus a real
// launch of the shapes Windows installs leave behind: npm's claude.cmd shim on
// PATH and the native installer's claude.exe in %USERPROFILE%\.local\bin.
import test from "node:test";
import { installNpmClaude, npmShimText } from "./fixtures/npm-claude.mjs";
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
  return file.endsWith(".cmd") ? npmShimText(globalTarget) : JSON.stringify({ bin: { claude: "./cli.js" } });
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
  // An extensionless `claude` (npm's script for Git Bash) is not something cmd can run.
  assert.equal(locateWin(["C:\\Program Files\\nodejs\\claude"]), null);
});

function standaloneFile(file) {
  if (/\.(cmd|bat)$/i.test(file)) return '@node "%~dp0record.cjs" %*\r\n';
  throw Object.assign(new Error("missing package.json"), { code: "ENOENT" });
}

test("Windows: standalone wrappers are found on PATH without an npm manifest", () => {
  const dir = "D:\\Package Managers\\bin";
  for (const ext of [".cmd", ".bat"]) {
    const wrapper = W.join(dir, "claude" + ext);
    const later = "C:\\native\\claude.exe";
    const env = { ...WIN_ENV, Path: `.;${dir};${W.dirname(later)}` };
    for (const files of [[wrapper], [wrapper, later]]) {
      assert.deepEqual(locateWin(files, { env, readFile: standaloneFile }),
        { command: wrapper, source: "path" });
    }
  }
});

test("Windows: standalone wrappers use System32 cmd and exclude the child cwd from lookup", () => {
  const cwd = "C:\\project";
  const env = { SystemRoot: "D:\\Windows", ComSpec: "cmd.exe", Path: ".;C:tools;C:\\project;D:\\bin",
    NODEFAULTCURRENTDIRECTORYINEXEPATH: "0", CLAUDE_CONFIG_DIR: "D:\\config" };
  for (const ext of [".cmd", ".bat"]) {
    const wrapper = W.join("D:\\bin", "claude" + ext);
    const job = claudeInvocation(wrapper, ["--resume", "a & b"], "win32", standaloneFile, { env, cwd });
    assert.equal(job.command, "D:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(job.args, ["/d", "/s", "/c", `"${wrapper} ^^^"--resume^^^" ^^^"a^^^ ^^^&^^^ b^^^""`]);
    assert.equal(job.options.windowsVerbatimArguments, true);
    assert.deepEqual(job.options.env, { SystemRoot: env.SystemRoot, ComSpec: job.command,
      Path: "D:\\bin", NoDefaultCurrentDirectoryInExePath: "1", CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR });
  }
});

const batchArgs = ['a"&echo pwned', '5" > out', "%PATH%", "^", '{"prompt":"say hello"}'];
const escapedBatchArgs = [
  String.raw`^^^"a\^^^"^^^&echo^^^ pwned^^^"`,
  String.raw`^^^"5\^^^"^^^ ^^^>^^^ out^^^"`,
  '^^^"^^^%PATH^^^%^^^"',
  '^^^"^^^^^^^"',
  String.raw`^^^"{\^^^"prompt\^^^":\^^^"say^^^ hello\^^^"}^^^"`,
];

test("Windows: every batch wrapper double-escapes forwarded arguments", () => {
  for (const dir of [String.raw`D:\pnpm`, String.raw`D:\Yarn\bin`, String.raw`D:\project\node_modules\.bin`]) {
    for (const ext of [".cmd", ".bat"]) {
      const wrapper = W.join(dir, "claude" + ext);
      const job = claudeInvocation(wrapper, batchArgs, "win32", standaloneFile);
      assert.deepEqual(job.args, ["/d", "/s", "/c", `"${wrapper} ${escapedBatchArgs.join(" ")}"`]);
    }
  }
});

test("Windows: a neighboring npm package cannot replace a custom wrapper", () => {
  const dir = String.raw`D:\npm`;
  const shim = W.join(dir, "claude.cmd");
  const stock = npmShimText(globalTarget);
  for (const [wrapper, body] of [
    [W.join(dir, "claude.bat"), stock],
    [shim, '@node "%~dp0custom.cjs" %*'],
    [shim, stock.replace("SETLOCAL", "SETLOCAL\r\nSET WRAPPER_ACTIVE=1")],
    [shim, stock.replace("%*", "--custom %*")],
    [shim, stock + "@echo finished\r\n"],
    [shim, npmShimText(globalTarget.replace("cli.js", "other.js"))],
  ]) {
    const readFile = file => file === wrapper ? body : readNpmFile(file);
    const env = { ...WIN_ENV, Path: dir };
    const location = locateWin([wrapper, W.join(dir, globalTarget)], { env, readFile });
    assert.equal(location?.command, wrapper);
    assert.equal(claudeInvocation(location.command, [], "win32", readFile, { env }).args[3], `"${wrapper}"`);
  }
});

test("Windows: a broken Claude shim cannot hide a runnable native CLI", () => {
  const wrapper = "C:\\wrappers";
  const native = "D:\\native";
  const bin = W.join(wrapper, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  const shim = W.join(wrapper, "claude.cmd");
  for (const dir of [wrapper, native]) {
    const exe = W.join(dir, "claude.exe");
    const env = { ...WIN_ENV, Path: wrapper + ";" + native, PATHEXT: ".CMD;.BAT;.EXE" };
    for (const [manifest, files] of [
      ["{", []], ['{"bin":{"claude":"cli.js"}}', []],
      ['{"bin":"../outside.js"}', [W.resolve(W.dirname(bin), "../outside.js")]],
    ]) {
      const readFile = file => file === shim ? npmShimText(globalTarget) : manifest;
      assert.equal(locateWin([shim, exe, ...files], { env, readFile })?.command, exe);
    }
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

test("Windows: standalone .bat forwards literal argv through node on PATH without side effects", {
  skip: !isWindows && "Windows only",
}, (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "package manager");
  const cwd = path.join(dir, "project");
  fs.mkdirSync(bin);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(bin, "claude.bat"), '@node "%~dp0record.cjs" %*\r\n');
  fs.writeFileSync(path.join(bin, "record.cjs"), "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  // A real package beside the selected .bat must not divert the launch to npm's bin.
  installNpmClaude(bin, "process.exit(43)");
  fs.unlinkSync(path.join(bin, "claude.cmd"));
  fs.writeFileSync(path.join(cwd, "node.cmd"), "@exit /b 42\r\n");
  const env = { ...process.env, Path: [cwd, bin, path.dirname(process.execPath)].join(";"),
    PATHEXT: ".CMD;.BAT;.EXE" };
  delete env.PATH;
  const found = locateClaude({ env, registryPath: () => [] });
  assert.equal(found?.command, path.join(bin, "claude.bat"));
  const options = { env, cwd, encoding: "utf8" };
  const job = claudeInvocation(found.command, batchArgs, "win32", undefined, options);
  assert.ok(job.args[3].endsWith(` ${escapedBatchArgs.join(" ")}"`));
  const result = spawnClaudeSync(found.command, batchArgs, options);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, JSON.stringify(batchArgs));
  assert.deepEqual(fs.readdirSync(cwd), ["node.cmd"]);
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
      const job = claudeInvocation(shim, args, "win32", file => {
        if (file === shim) return npmShimText(W.relative(W.dirname(shim), W.join(pkg, bin)));
        assert.equal(file, W.join(pkg, "package.json"));
        return JSON.stringify({ bin: { claude: bin } });
      });
      const entry = W.join(pkg, bin);
      assert.deepEqual(job, bin.endsWith(".js")
        ? { command: process.execPath, args: [entry, ...args] }
        : { command: entry, args });
    }
  }
  assert.throws(() => claudeInvocation("claude.cmd", args, "win32"));
  assert.deepEqual(claudeInvocation("C:\\Tools\\claude.exe", args, "win32"),
    { command: "C:\\Tools\\claude.exe", args });
});
