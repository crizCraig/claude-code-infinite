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
 * (the CI check of this flow); it still installs only on a yes.
 */
import spawn from "cross-spawn";
import * as fs from "node:fs";
import * as path from "node:path";
import { claudeMissingText } from "./claude-locate.js";
/** Anthropic's official install one-liners (https://code.claude.com/docs/en/setup). */
export const WINDOWS_INSTALL_SCRIPT = "irm https://claude.ai/install.ps1 | iex";
export const POSIX_INSTALL_SCRIPT = "curl -fsSL https://claude.ai/install.sh | bash";
export const INSTALL_QUESTION = "Claude Code isn't installed. Install it now? [Y/n] ";
export const DESKTOP_ONLY_LINE = "You have the Claude desktop app; ccc needs Claude Code (the command-line tool).";
export const INSTALL_PROMPT_ENV = "CCC_INSTALL_PROMPT";
/**
 * Claude Code isn't installed: offer to install it. Returns where it is after a
 * successful install, else null (declined, no terminal, or the install failed),
 * having printed what to do by hand.
 */
export async function offerClaudeInstall(deps) {
    const platform = deps.platform ?? process.platform;
    if (!deps.canAsk)
        return null;
    if (deps.desktopOnly)
        deps.print(DESKTOP_ONLY_LINE);
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
export function isYes(answer) {
    if (answer === null)
        return false;
    return /^(y|yes)?$/i.test(answer.trim());
}
/** The installer for this OS: the official one-liner, run by the shell its docs name. */
export function installerCommand(platform = process.platform, env = process.env, exists = fs.existsSync) {
    if (platform === "win32") {
        return {
            command: windowsPowerShell(env, exists),
            args: ["-NoProfile", "-Command", WINDOWS_INSTALL_SCRIPT],
            display: WINDOWS_INSTALL_SCRIPT,
        };
    }
    // pipefail: a failed download fails the install instead of running an empty script.
    return {
        command: "bash",
        args: ["-c", `set -o pipefail; ${POSIX_INSTALL_SCRIPT}`],
        display: POSIX_INSTALL_SCRIPT,
    };
}
/** Run the installer with its output on this terminal; never throws. */
export function runInstaller(installer) {
    return new Promise((resolve) => {
        try {
            const child = spawn(installer.command, installer.args, { stdio: "inherit" });
            child.on("error", (error) => resolve({ code: null, error }));
            child.on("close", (code) => resolve({ code }));
        }
        catch (error) {
            resolve({ code: null, error: error });
        }
    });
}
// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------
async function installClaude(deps, platform) {
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
    const reason = run.error ? "spawn" : run.code !== 0 ? "exit" : "not_found";
    deps.record("install_failed", { reason, code: run.code ?? undefined, ms });
    deps.print(`\n${failureLine(run, installer)}\n\n${claudeMissingText(platform)}`);
    return null;
}
function failureLine(run, installer) {
    if (run.error) {
        return `Couldn't run Claude Code's installer (${installer.command}): ${run.error.message}`;
    }
    if (run.code !== 0) {
        return `Claude Code's installer failed (exit code ${run.code ?? "none: it was stopped"}).`;
    }
    return "Claude Code's installer finished, but ccc still can't find `claude`.";
}
/** Windows PowerShell by full path (PATH may be what is broken), else by name. */
function windowsPowerShell(env, exists) {
    const root = envValue(env, "SystemRoot") || envValue(env, "windir") || "C:\\Windows";
    const full = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return exists(full) ? full : "powershell.exe";
}
function envValue(env, name) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
    return key === undefined ? undefined : env[key];
}
//# sourceMappingURL=claude-install.js.map