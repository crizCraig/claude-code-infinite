/**
 * Finding Claude Code to launch, however it was installed.
 *
 * ccc locates `claude` on PATH (with
 * PATHEXT on Windows, so npm's `claude.cmd` shim and the native `claude.exe`
 * both run). What it cannot do is find a Claude Code that is installed but not
 * on this terminal's PATH. On Windows that is the common case: the native
 * installer puts `claude.exe` in `%USERPROFILE%\.local\bin` and may only ask
 * the user to add it to PATH, winget links it under
 * `%LOCALAPPDATA%\Microsoft\WinGet\Links`, and any installer that does update
 * the user's PATH (in the registry) leaves terminals already open without it.
 * So after PATH this looks in the user's and machine's registry PATH, then in
 * each installer's own location. On macOS and Linux it checks the native
 * installer's `~/.local/bin`, the legacy `~/.claude/local` and Homebrew.
 *
 * Only paths are probed; nothing is run except `reg query` on Windows, and
 * only when PATH has no `claude`.
 */
/** Where Claude Code was found, for diagnostics (an enum, never a path). */
export declare const CLAUDE_SOURCES: readonly ["path", "registry-path", "native", "npm", "winget", "homebrew", "legacy-local"];
export type ClaudeSource = (typeof CLAUDE_SOURCES)[number];
/** `claude_found` in diagnostics: a source, or `desktop_only` (only the desktop app is installed). */
export declare const CLAUDE_FOUND: readonly ["path", "registry-path", "native", "npm", "winget", "homebrew", "legacy-local", "desktop_only"];
export interface ClaudeLocation {
    /** What to spawn: an absolute path, or `claude` on the POSIX PATH. */
    command: string;
    source: ClaudeSource;
    /** Not on PATH: its directory, to put on the child's PATH. */
    dir?: string;
}
export interface LocateClaudeOptions {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    homedir?: string;
    /** True when `file` exists and can be run. */
    isExecutable?: (file: string) => boolean;
    /** The adjacent Claude npm package manifest for a Windows shim. */
    readManifest?: (file: string) => string;
    /** Windows: the user's and the machine's PATH from the registry. */
    registryPath?: () => string[];
    /** Directory entries (winget's package folders); [] when unreadable. */
    listDir?: (dir: string) => string[];
}
export interface DesktopAppOptions {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    homedir?: string;
    /** True when the path exists (file or folder). */
    exists?: (file: string) => boolean;
}
export declare function claudeNpmBin(command: string, readManifest?: (file: string) => string): string | undefined;
/** Claude Code to launch, or null when it is not installed anywhere known. */
export declare function locateClaude(opts?: LocateClaudeOptions): ClaudeLocation | null;
/** The child's environment with `location.dir` first on PATH, when it was not on PATH. */
export declare function withClaudeOnPath(env: NodeJS.ProcessEnv, location: ClaudeLocation, platform?: NodeJS.Platform): NodeJS.ProcessEnv;
/**
 * Whether the Claude desktop app is installed (Windows, macOS). It runs Claude
 * Code inside the app (its own copy, in the app's data folder, kept at the
 * app's version), but puts no `claude` on the terminal's PATH, so ccc cannot
 * use it. Only its own folders count, never `~/.claude`, which the CLI shares.
 */
export declare function claudeDesktopInstalled(opts?: DesktopAppOptions): boolean;
/** Said instead of claudeMissingText when only the desktop app is installed. */
export declare function claudeDesktopOnlyText(platform?: NodeJS.Platform): string;
/**
 * Said once, instead of launching, when Claude Code is not installed: the
 * official install command for this OS and the sign-in step.
 */
export declare function claudeMissingText(platform?: NodeJS.Platform): string;
/**
 * One line, not blocking, when ccc starts somewhere that is not a project:
 * C:\Windows\System32 (where an admin terminal opens) or the home folder.
 */
export declare function cwdHintText(cwd: string, opts?: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    homedir?: string;
}): string | null;
/** Resolve a helper without an implicit working-directory or relative PATH lookup. */
export declare function findPathExecutable(filename: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, cwd: string, isExecutable?: (file: string) => boolean): string | undefined;
/** cmd must not look up a shim's tools in the project, implicitly or via PATH. */
export declare function windowsShellEnv(env: NodeJS.ProcessEnv, cwd: string): {
    [x: string]: string | undefined;
    NoDefaultCurrentDirectoryInExePath: string;
    ComSpec: string;
};
/** `%USERPROFILE%\.local\bin` → its value; unknown names stay as written. */
export declare function expandWindowsVars(value: string, env: NodeJS.ProcessEnv): string;
/** The Path values in `reg query` output (REG_SZ or REG_EXPAND_SZ). */
export declare function parseRegQueryPath(output: string): string | null;
/** System tools always use a drive-qualified or UNC System32 directory. */
export declare function system32Path(env: NodeJS.ProcessEnv, ...parts: string[]): string;
//# sourceMappingURL=claude-locate.d.ts.map