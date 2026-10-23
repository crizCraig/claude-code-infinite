/**
 * Offering to install Claude Code when ccc can't find it (claude-locate.ts).
 *
 * In a terminal ccc asks once: "Claude Code isn't installed. Install it now? [Y/n]".
 * Only a typed yes (or Enter, the prompt's default) runs Anthropic's official
 * installer, the same one-liner its docs give; its output streams to the terminal.
 * ccc then looks for Claude Code again, including the installers' own folders,
 * so no new terminal is needed, and starts it (Claude Code asks the user to sign
 * in the first time). Without a terminal nothing is asked or installed: ccc prints
 * the install steps, as before.
 *
 * CCC_INSTALL_PROMPT=1 asks even without a terminal, reading the answer from stdin
 * (the CI check of this flow); it still installs only on a yes. The answer is read
 * with readline, which takes all of piped stdin, so don't also pipe a prompt then.
 */

import spawn from "cross-spawn";
import * as path from "node:path";
import { claudeMissingText, type ClaudeLocation } from "./claude-locate.js";

/** Anthropic's official install one-liners (https://code.claude.com/docs/en/setup). */
export const WINDOWS_INSTALL_SCRIPT = "irm https://claude.ai/install.ps1 | iex";
export const POSIX_INSTALL_SCRIPT = "curl -fsSL https://claude.ai/install.sh | bash";
export const INSTALL_QUESTION = "Claude Code isn't installed. Install it now? [Y/n] ";
export const DESKTOP_ONLY_LINE =
  "You have the Claude desktop app; ccc needs Claude Code (the command-line tool).";
export const INSTALL_PROMPT_ENV = "CCC_INSTALL_PROMPT";
/** install_failed's reason (diagnostics-schema.ts INSTALL_FAILURES). */
export type InstallFailure = "spawn" | "exit" | "not_found";

export interface InstallerCommand {
  command: string;
  args: string[];
  /** What the user would type themselves. */
  display: string;
  /** The installer's environment, when it differs from ccc's. */
  env?: NodeJS.ProcessEnv;
}

export interface InstallerRun {
  /** The installer's exit code; null when it was killed or never started. */
  code: number | null;
  /** Set when it could not be started. */
  error?: Error;
}

export interface InstallOfferDeps {
  platform?: NodeJS.Platform;
  /** A person can answer (a terminal, or CCC_INSTALL_PROMPT=1). */
  canAsk: boolean;
  /** Only the Claude desktop app is installed. */
  desktopOnly: boolean;
  /** The answer typed, or null when there is none (stdin closed, Ctrl+C). */
  ask: (question: string) => Promise<string | null>;
  runInstaller: (installer: InstallerCommand) => Promise<InstallerRun>;
  /** claude-locate.ts locateClaude, run again after the install. */
  locate: () => ClaudeLocation | null;
  /** A line (or lines) for the user. */
  print: (text: string) => void;
  /** Diagnostics: enums and numbers only. */
  record: (name: string, fields?: Record<string, unknown>) => void;
  /** Send what is recorded now (the install may take a while, or be interrupted). */
  flushNow?: () => void;
  now?: () => number;
}

/**
 * Claude Code isn't installed: offer to install it. Returns where it is after a
 * successful install, else null (declined, no terminal, or the install failed),
 * having printed what to do by hand.
 */
export async function offerClaudeInstall(deps: InstallOfferDeps): Promise<ClaudeLocation | null> {
  const platform = deps.platform ?? process.platform;
  if (!deps.canAsk) return null;
  if (deps.desktopOnly) deps.print(DESKTOP_ONLY_LINE);
  deps.record("install_offered", { desktop_only: deps.desktopOnly });
  deps.flushNow?.();
  const answer = await deps.ask(INSTALL_QUESTION);
  if (!isYes(answer)) {
    deps.record("install_declined");
    deps.print(claudeMissingText(platform));
    return null;
  }
  deps.record("install_accepted");
  deps.flushNow?.();
  return installClaude(deps, platform);
}

/** A yes: Enter (the default) or y/yes, in any case. Anything else, or no answer, is a no. */
export function isYes(answer: string | null): boolean {
  if (answer === null) return false;
  return /^(y|yes)?$/i.test(answer.trim());
}

/** The installer for this OS: the official one-liner, run by the shell its docs name. */
export function installerCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): InstallerCommand {
  if (platform === "win32") {
    return {
      command: windowsPowerShell(env),
      args: ["-NoProfile", "-Command", WINDOWS_INSTALL_SCRIPT],
      display: WINDOWS_INSTALL_SCRIPT,
      env: withoutPsModulePath(env),
    };
  }
  // pipefail: a failed download fails the install instead of running an empty script.
  return {
    command: "bash",
    args: ["-c", `set -o pipefail; ${POSIX_INSTALL_SCRIPT}`],
    display: POSIX_INSTALL_SCRIPT,
  };
}

/**
 * Run the installer with its output on this terminal; never throws. `toStderr`:
 * its stdout goes to stderr too (a print run's stdout is Claude Code's alone).
 */
export function runInstaller(installer: InstallerCommand, toStderr = false): Promise<InstallerRun> {
  return new Promise((resolve) => {
    try {
      const child = spawn(installer.command, installer.args, {
        stdio: ["inherit", toStderr ? process.stderr : "inherit", "inherit"],
        ...(installer.env ? { env: installer.env } : {}),
      });
      child.on("error", (error: Error) => resolve({ code: null, error }));
      child.on("close", (code: number | null) => resolve({ code }));
    } catch (error) {
      resolve({ code: null, error: error as Error });
    }
  });
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

async function installClaude(
  deps: InstallOfferDeps, platform: NodeJS.Platform
): Promise<ClaudeLocation | null> {
  const installer = installerCommand(platform);
  const now = deps.now ?? Date.now;
  const started = now();
  deps.print(`Installing Claude Code with Anthropic's installer:\n  ${installer.display}\n`);
  const run = await deps.runInstaller(installer);
  const ms = now() - started;
  const found = run.error ? null : deps.locate();
  if (found) {
    deps.record("install_succeeded", { ms, claude_found: found.source });
    deps.print("\n✔ Claude Code is installed. Starting it now: " +
      "the first time, it asks you to sign in to your Claude account.\n");
    return found;
  }
  const reason: InstallFailure = run.error ? "spawn" : run.code !== 0 ? "exit" : "not_found";
  deps.record("install_failed", { reason, code: run.code ?? undefined, ms });
  deps.print(`\n${failureLine(run, installer)}\n\n${claudeMissingText(platform)}`);
  return null;
}

function failureLine(run: InstallerRun, installer: InstallerCommand): string {
  if (run.error) {
    return `Couldn't run Claude Code's installer (${installer.command}): ${run.error.message}`;
  }
  if (run.code !== 0) {
    return `Claude Code's installer failed (exit code ${run.code ?? "none: it was stopped"}).`;
  }
  return "Claude Code's installer finished, but ccc still can't find `claude`.";
}

/**
 * Windows PowerShell, always by full path: PATH may be what is broken, and a
 * search by name would try the current folder (a project's powershell.exe) first.
 * Missing, the spawn fails and the manual steps are shown.
 */
function windowsPowerShell(env: NodeJS.ProcessEnv): string {
  const root = envValue(env, "SystemRoot") || envValue(env, "windir") || "C:\\Windows";
  return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * ccc started from PowerShell 7 inherits its PSModulePath, which makes Windows
 * PowerShell 5.1 load 7's modules and lose its own (the installer's Get-FileHash
 * is then "not recognized"). Without it, 5.1 builds its default path.
 */
function withoutPsModulePath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH")
  );
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}
