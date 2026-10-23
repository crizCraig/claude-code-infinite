// End to end: ccc on a machine WITHOUT Claude Code (a clean CI runner) offers to install
// it, the answer "y" runs Anthropic's real official installer, and Claude Code is then
// found and runs (`claude --version`; no sign-in needed). Run from the repo root after
// `npm run build`: node scripts/e2e/install-offer-e2e.mjs
//
// It installs Claude Code into this user's home, so it refuses to run outside CI unless
// CCC_E2E_INSTALL=1. No keys, no network beyond the installer; diagnostics are off.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { locateClaude } from "../../dist/claude-locate.js";
import { INSTALL_QUESTION } from "../../dist/claude-install.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "dist", "cli.js");
const TIMEOUT_MS = 10 * 60_000;
const results = [];
// A terminal opened before the install: the installer's folder is not on its PATH
// (GitHub's macOS and Linux images already have ~/.local/bin there).
const ENV = withoutInstallDirOnPath(process.env);

if (process.env.CI !== "true" && process.env.CCC_E2E_INSTALL !== "1") {
  console.error("This installs Claude Code for this user: run it in CI, or set CCC_E2E_INSTALL=1.");
  process.exit(2);
}

check("Claude Code is not installed before the run", () => {
  const before = locateClaude({ env: ENV });
  if (before) throw new Error(`already installed (${before.source}): this check needs a clean runner`);
});
const run = await runCccAnsweringYes();
check("the install question was asked", () => expect(run.stderr.includes(INSTALL_QUESTION)));
check("the official installer ran", () =>
  expect(run.stderr.includes("Installing Claude Code with Anthropic's installer")));
check("ccc found Claude Code after the install", () =>
  expect(run.stderr.includes("✔ Claude Code is installed"), `exit ${run.status}`));
check("ccc went on to the next first-run step (no MemTree key, no terminal)", () =>
  expect(run.stderr.includes("A MemTree API key is required"), `exit ${run.status}`));
const after = locateClaude({ env: ENV });
check("claude-locate finds it, in this same terminal session", () =>
  expect(after !== null, "locateClaude() is null"));
if (after) {
  check(`found where the installer put it, not on PATH (${after.source})`, () =>
    expect(after.source === "native", after.source));
  check("`claude --version` works", () => {
    const version = spawnSync(after.command, ["--version"], { encoding: "utf8", shell: false });
    expect(/\(Claude Code\)/.test(version.stdout ?? ""), `${version.status}: ${version.stdout}`);
    return version.stdout.trim();
  });
}
check("`ccc --version` shows Claude Code's version", () => {
  const version = spawnSync(process.execPath, [CLI, "--version"], { encoding: "utf8", env: ENV });
  expect(/\(Claude Code\)/.test(version.stdout), version.stdout + version.stderr);
});

report();

/** ccc -p with CCC_INSTALL_PROMPT=1: "y" is typed once the question appears. */
function runCccAnsweringYes() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "-p", "hi"], {
      env: { ...ENV, CCC_INSTALL_PROMPT: "1", CCC_NO_DIAGNOSTICS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let answered = false;
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.stdout.on("data", (d) => { stdout += d; process.stdout.write(d); });
    child.stderr.on("data", (d) => {
      stderr += d;
      process.stdout.write(d);
      if (!answered && stderr.includes(INSTALL_QUESTION)) {
        answered = true;
        child.stdin.end("y\n");
      }
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (!answered) child.stdin.destroy();
      resolve({ status, stdout, stderr });
    });
  });
}

function withoutInstallDirOnPath(env) {
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const installDir = path.join(os.homedir(), ".local", "bin");
  const out = { ...env };
  for (const key of Object.keys(out).filter((k) => k.toUpperCase() === "PATH")) {
    out[key] = out[key].split(path.delimiter).filter((dir) => dir && !same(dir, installDir))
      .join(path.delimiter);
  }
  return out;
}

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
  }
}

function expect(condition, detail = "") {
  if (!condition) throw new Error(detail || "not as expected");
}

function report() {
  const lines = results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `: ${r.detail}` : ""}`);
  const summary = `\n## ccc install offer e2e (${process.platform})\n\n${lines.join("\n")}\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n\`\`\`${summary}\`\`\`\n`);
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
