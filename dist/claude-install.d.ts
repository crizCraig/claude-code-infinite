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
import { type ClaudeLocation } from "./claude-locate.js";
/** Anthropic's official install one-liners (https://code.claude.com/docs/en/setup). */
export declare const WINDOWS_INSTALL_SCRIPT = "irm https://claude.ai/install.ps1 | iex";
export declare const POSIX_INSTALL_SCRIPT = "curl -fsSL https://claude.ai/install.sh | bash";
export declare const INSTALL_QUESTION = "Claude Code isn't installed. Install it now? [Y/n] ";
export declare const DESKTOP_ONLY_LINE = "You have the Claude desktop app; ccc needs Claude Code (the command-line tool).";
export declare const INSTALL_PROMPT_ENV = "CCC_INSTALL_PROMPT";
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
export declare function offerClaudeInstall(deps: InstallOfferDeps): Promise<ClaudeLocation | null>;
/** A yes: Enter (the default) or y/yes, in any case. Anything else, or no answer, is a no. */
export declare function isYes(answer: string | null): boolean;
/** The installer for this OS: the official one-liner, run by the shell its docs name. */
export declare function installerCommand(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, exists?: (file: string) => boolean): InstallerCommand;
/** Run the installer with its output on this terminal; never throws. */
export declare function runInstaller(installer: InstallerCommand): Promise<InstallerRun>;
//# sourceMappingURL=claude-install.d.ts.map