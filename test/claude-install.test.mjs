// The offer to install Claude Code when ccc can't find it (claude-install.ts): asked
// only when someone can answer, installed only on a yes, then found and started; and a
// real ccc run on a machine without Claude Code (a fake installer stands in for curl).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_ONLY_LINE,
  INSTALL_QUESTION,
  POSIX_INSTALL_SCRIPT,
  WINDOWS_INSTALL_SCRIPT,
  installerCommand,
  isYes,
  offerClaudeInstall,
  runInstaller,
} from "../dist/claude-install.js";
import { claudeDesktopOnlyText, claudeMissingText } from "../dist/claude-locate.js";
import { sanitizeEvent } from "../dist/diagnostics-schema.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FOUND = { command: "/home/ada/.local/bin/claude", source: "native", dir: "/home/ada/.local/bin" };

/** offerClaudeInstall with fakes; `answer` is what is typed, `run`/`found` the install's outcome. */
async function offer({ answer = "y", canAsk = true, desktopOnly = false, run = { code: 0 },
                       found = FOUND, platform = "linux" } = {}) {
  const calls = { asked: [], installers: [], printed: [], events: [], flushes: 0, located: 0 };
  let t = 1000;
  const result = await offerClaudeInstall({
    platform, canAsk, desktopOnly,
    ask: async (q) => { calls.asked.push(q); return answer; },
    runInstaller: async (installer) => { calls.installers.push(installer); t += 4200; return run; },
    locate: () => { calls.located += 1; return found; },
    print: (text) => calls.printed.push(text),
    record: (name, fields = {}) => calls.events.push({ name, ...fields }),
    flushNow: () => { calls.flushes += 1; },
    now: () => t,
  });
  return { result, ...calls, out: calls.printed.join("\n") };
}

test("yes (or Enter) runs the official installer, finds Claude Code and returns it", async () => {
  for (const answer of ["y", "Y", "yes", " YES ", ""]) {
    const r = await offer({ answer });
    assert.deepEqual(r.result, FOUND, answer);
    assert.deepEqual(r.asked, [INSTALL_QUESTION]);
    assert.equal(r.installers.length, 1);
    assert.equal(r.installers[0].display, POSIX_INSTALL_SCRIPT);
    assert.match(r.out, /✔ Claude Code is installed\. When it starts/);
    assert.match(r.out, /sign in/);
    assert.deepEqual(r.events.map((e) => e.name),
      ["install_offered", "install_accepted", "install_succeeded"]);
    assert.deepEqual(r.events[2], { name: "install_succeeded", ms: 4200, claude_found: "native" });
    assert.ok(r.flushes >= 2, "offered and accepted are sent before the install runs");
  }
  assert.equal(INSTALL_QUESTION, "Claude Code isn't installed. Install it now? [Y/n] ");
});

test("no, anything else, or no answer: nothing is installed and the manual steps are shown", async () => {
  for (const answer of ["n", "no", "N", "maybe", "yy", null]) {
    const r = await offer({ answer });
    assert.equal(r.result, null, String(answer));
    assert.equal(r.installers.length, 0, "never installs without a yes");
    assert.equal(r.located, 0);
    assert.equal(r.out, claudeMissingText("linux"));
    assert.deepEqual(r.events.map((e) => e.name), ["install_offered", "install_declined"]);
  }
});

test("no one to ask: no question, no install, no events (the caller prints the steps)", async () => {
  const r = await offer({ canAsk: false });
  assert.equal(r.result, null);
  assert.deepEqual([r.asked, r.installers, r.printed, r.events], [[], [], [], []]);
});

test("desktop app only: says so, then the same offer", async () => {
  const r = await offer({ desktopOnly: true, platform: "win32" });
  assert.equal(r.printed[0], DESKTOP_ONLY_LINE);
  assert.equal(DESKTOP_ONLY_LINE,
    "You have the Claude desktop app; ccc needs Claude Code (the command-line tool).");
  assert.deepEqual(r.asked, [INSTALL_QUESTION]);
  assert.equal(r.installers[0].display, WINDOWS_INSTALL_SCRIPT);
  assert.deepEqual(r.events[0], { name: "install_offered", desktop_only: true });
});

test("a failed install: the error, the manual steps, and why in diagnostics", async () => {
  const exit = await offer({ run: { code: 1 }, found: null });
  assert.equal(exit.result, null);
  assert.match(exit.out, /Claude Code's installer failed \(exit code 1\)\./);
  assert.ok(exit.out.endsWith(claudeMissingText("linux")));
  assert.deepEqual(exit.events.at(-1), { name: "install_failed", reason: "exit", code: 1, ms: 4200 });

  const spawnErr = await offer({ run: { code: null, error: new Error("spawn bash ENOENT") } });
  assert.equal(spawnErr.result, null, "not looked for: the installer never ran");
  assert.match(spawnErr.out, /Couldn't run Claude Code's installer \(bash\): spawn bash ENOENT/);
  assert.equal(spawnErr.events.at(-1).reason, "spawn");

  const missing = await offer({ run: { code: 0 }, found: null });
  assert.match(missing.out, /installer finished, but ccc still can't find `claude`/);
  assert.equal(missing.events.at(-1).reason, "not_found");

  // A nonzero exit that still left Claude Code installed counts as installed.
  assert.deepEqual((await offer({ run: { code: 1 } })).result, FOUND);
});

test("the installer per OS: PowerShell's one-liner on Windows, curl | bash elsewhere", () => {
  const win = installerCommand("win32", { SystemRoot: "D:\\Win" });
  assert.equal(win.command, "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(win.args, ["-NoProfile", "-Command", "irm https://claude.ai/install.ps1 | iex"]);
  // Never by name: a search would try the current folder first.
  assert.equal(installerCommand("win32", {}).command,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  // PowerShell 7's module path breaks Windows PowerShell 5.1's own cmdlets: dropped.
  const fromPwsh = installerCommand("win32",
    { PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules", Path: "C:\\x" });
  assert.deepEqual(fromPwsh.env, { Path: "C:\\x" });
  for (const platform of ["darwin", "linux"]) {
    const posix = installerCommand(platform, {});
    assert.equal(posix.command, "bash");
    assert.equal(posix.env, undefined, "ccc's own environment");
    assert.deepEqual(posix.args,
      ["-c", "set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash"]);
  }
});

test("isYes: Enter and y/yes only", () => {
  assert.deepEqual(["", "y", "Yes", "\n"].map(isYes), [true, true, true, true]);
  assert.deepEqual(["n", "no", "nope", "y es", null].map(isYes), [false, false, false, false, false]);
});

test("runInstaller: the exit code, or the error when it can't start; never throws", async () => {
  const ok = await runInstaller({ command: process.execPath, args: ["-e", "process.exit(3)"], display: "" });
  assert.deepEqual(ok, { code: 3 });
  const missing = await runInstaller({ command: "ccc-no-such-installer", args: [], display: "" });
  assert.equal(missing.code, null);
  assert.ok(missing.error instanceof Error);
});

test("the install events pass the diagnostics allowlist; other values are dropped", () => {
  assert.deepEqual(sanitizeEvent("install_offered", { desktop_only: true }, 1),
    { desktop_only: true, name: "install_offered", t: 1 });
  assert.deepEqual(sanitizeEvent("install_failed", { reason: "exit", code: 1, ms: 5, msg: "x" }, 1),
    { reason: "exit", code: 1, ms: 5, name: "install_failed", t: 1 });
  assert.deepEqual(sanitizeEvent("install_succeeded", { claude_found: "C:\\x", ms: 2 }, 1),
    { ms: 2, name: "install_succeeded", t: 1 });
  assert.equal(sanitizeEvent("install_failed", { reason: "boom" }, 1).reason, undefined);
});

// ---------------------------------------------------------------------------
// ccc itself, on a machine without Claude Code
// ---------------------------------------------------------------------------

/** A first-time machine: no ccc config, no Claude Code; `bin` first on PATH. */
function freshCcc({ input, env = {}, bin } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-install-"));
  const dirs = [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].filter(Boolean);
  const run = spawnSync(process.execPath, [cli, "-p", "hi"], {
    env: {
      ...process.env, HOME: home, USERPROFILE: home, CCC_NO_DIAGNOSTICS: "1",
      PATH: dirs.join(path.delimiter), Path: dirs.join(path.delimiter),
      LOCALAPPDATA: home, APPDATA: home, ProgramFiles: home, ...env,
    },
    input, encoding: "utf8", timeout: 30_000,
  });
  return { ...run, home };
}

test("ccc without a terminal: the install steps only, no question (as before)", () => {
  const run = freshCcc({ input: "y\n" });
  assert.equal(run.status, 1, run.stderr);
  // The desktop-app variant on a machine that has the Claude desktop app.
  assert.ok(run.stderr.includes(claudeMissingText()) ||
    run.stderr.includes(claudeDesktopOnlyText()), run.stderr);
  assert.doesNotMatch(run.stderr, /Install it now\?/);
  assert.equal(run.stdout, "");
});

test("ccc with CCC_INSTALL_PROMPT=1, answered no: asked, nothing installed", () => {
  const run = freshCcc({ input: "n\n", env: { CCC_INSTALL_PROMPT: "1" } });
  assert.equal(run.status, 1, run.stderr);
  assert.ok(run.stderr.includes(INSTALL_QUESTION), run.stderr);
  assert.ok(run.stderr.includes(claudeMissingText()));
  assert.doesNotMatch(run.stderr, /Installing Claude Code/);
});

test("ccc with CCC_INSTALL_PROMPT=1, answered yes: installs, finds claude, continues",
  { skip: process.platform === "win32" && "the fake installer is a shell script" }, () => {
    // A fake `bash` that does what the official installer does: ~/.local/bin/claude.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-fake-bash-"));
    fs.writeFileSync(path.join(bin, "bash"), [
      "#!/bin/sh",
      `case "$2" in *"${POSIX_INSTALL_SCRIPT}"*) ;; *) echo "unexpected: $2" >&2; exit 9;; esac`,
      'mkdir -p "$HOME/.local/bin"',
      "printf '#!/bin/sh\\necho \"9.9.9 (Claude Code)\"\\n' > \"$HOME/.local/bin/claude\"",
      'chmod +x "$HOME/.local/bin/claude"',
      'echo "fake installer ran"',
    ].join("\n"), { mode: 0o755 });
    const run = freshCcc({ input: "y\n", env: { CCC_INSTALL_PROMPT: "1" }, bin });
    assert.ok(run.stderr.includes(INSTALL_QUESTION), run.stderr);
    assert.match(run.stderr, /fake installer ran/, "the installer's output goes to stderr");
    assert.equal(run.stdout, "", "a print run's stdout stays Claude Code's");
    assert.match(run.stderr, /✔ Claude Code is installed/);
    assert.ok(fs.existsSync(path.join(run.home, ".local", "bin", "claude")));
    // On to the next step of a first run: no key and no terminal.
    assert.match(run.stderr, /A MemTree API key is required/);
    assert.equal(run.status, 1);
  });
