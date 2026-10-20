/**
 * Finding Claude Code to launch, however it was installed.
 *
 * ccc launches `claude` through cross-spawn, which finds it on PATH (with
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

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where Claude Code was found, for diagnostics (an enum, never a path). */
export const CLAUDE_SOURCES = [
  "path", "registry-path", "native", "npm", "winget", "homebrew", "legacy-local",
] as const;
export type ClaudeSource = (typeof CLAUDE_SOURCES)[number];
/** `claude_found` in diagnostics: a source, or `desktop_only` (only the desktop app is installed). */
export const CLAUDE_FOUND = [...CLAUDE_SOURCES, "desktop_only"] as const;
export type ClaudeFound = (typeof CLAUDE_FOUND)[number];

export interface ClaudeLocation {
  /** What to spawn: `claude` when it is on PATH, else its absolute path. */
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

/** Claude Code to launch, or null when it is not installed anywhere known. */
export function locateClaude(opts: LocateClaudeOptions = {}): ClaudeLocation | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const isExecutable = opts.isExecutable ?? defaultIsExecutable(platform);
  const onPath = locateOnPath(pathDirs(env, platform), platform, env, isExecutable);
  if (onPath) return onPath;
  const home = opts.homedir ?? os.homedir();
  for (const candidate of candidates(platform, env, home, opts)) {
    const file = candidate.dirs
      .map((dir) => findOnPath("claude", [dir], platform, env, isExecutable))
      .find((f): f is string => f !== null && !isDesktopAppExe(f, platform));
    if (file) return { command: file, source: candidate.source, dir: pathFor(platform).dirname(file) };
  }
  return null;
}

/** The child's environment with `location.dir` first on PATH, when it was not on PATH. */
export function withClaudeOnPath(
  env: NodeJS.ProcessEnv,
  location: ClaudeLocation,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  if (!location.dir) return env;
  const key = pathKey(env, platform);
  const current = env[key];
  const delimiter = platform === "win32" ? ";" : ":";
  return { ...env, [key]: current ? `${location.dir}${delimiter}${current}` : location.dir };
}

/**
 * Whether the Claude desktop app is installed (Windows, macOS). It runs Claude
 * Code inside the app (its own copy, in the app's data folder, kept at the
 * app's version), but puts no `claude` on the terminal's PATH, so ccc cannot
 * use it. Only its own folders count, never `~/.claude`, which the CLI shares.
 */
export function claudeDesktopInstalled(opts: DesktopAppOptions = {}): boolean {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.homedir ?? os.homedir();
  const exists = opts.exists ?? fs.existsSync;
  return desktopAppPaths(platform, env, home).some((p) => exists(p));
}

/** Said instead of claudeMissingText when only the desktop app is installed. */
export function claudeDesktopOnlyText(platform: NodeJS.Platform = process.platform): string {
  const install = platform === "win32"
    ? "`irm https://claude.ai/install.ps1 | iex` (in PowerShell)"
    : "`curl -fsSL https://claude.ai/install.sh | bash`";
  return "Found the Claude desktop app, but ccc needs Claude Code in the terminal: " +
    `install it with ${install}, then open a new terminal and run \`claude\` once to sign in.`;
}

/**
 * Said once, instead of launching, when Claude Code is not installed: the
 * official install command for this OS and the sign-in step.
 */
export function claudeMissingText(platform: NodeJS.Platform = process.platform): string {
  const install = platform === "win32"
    ? "  irm https://claude.ai/install.ps1 | iex      (in PowerShell)"
    : "  curl -fsSL https://claude.ai/install.sh | bash";
  return [
    "Claude Code isn't installed. ccc runs Claude Code, so install it first:",
    install,
    "then open a new terminal, run `claude` once to sign in, and run ccc again.",
  ].join("\n");
}

/**
 * One line, not blocking, when ccc starts somewhere that is not a project:
 * C:\Windows\System32 (where an admin terminal opens) or the home folder.
 */
export function cwdHintText(
  cwd: string,
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; homedir?: string } = {}
): string | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const p = pathFor(platform);
  const same = (a: string, b: string) => {
    const norm = (s: string) => p.resolve(s).replace(/[\\/]+$/, "");
    return platform === "win32" || platform === "darwin"
      ? norm(a).toLowerCase() === norm(b).toLowerCase()
      : norm(a) === norm(b);
  };
  const home = opts.homedir ?? os.homedir();
  let where: string | null = null;
  if (platform === "win32") {
    const windows = env.SystemRoot || env.windir || "C:\\Windows";
    if (["System32", "SysWOW64"].some((d) => same(cwd, p.join(windows, d)))) where = cwd;
  }
  if (where === null && home && same(cwd, home)) where = "your home folder";
  if (where === null) return null;
  return `Tip: ccc is running in ${where}. Run it from your project folder (cd into it, then ccc) ` +
    "so Claude Code works on that project.";
}

// ---------------------------------------------------------------------------
// Candidates and PATH search
// ---------------------------------------------------------------------------

interface Candidate {
  source: ClaudeSource;
  dirs: string[];
}

function candidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
  opts: LocateClaudeOptions
): Candidate[] {
  if (platform === "win32") return windowsCandidates(env, home, opts);
  const p = path.posix;
  return [
    { source: "native", dirs: [p.join(home, ".local", "bin")] },
    { source: "legacy-local", dirs: [p.join(home, ".claude", "local")] },
    { source: "homebrew", dirs: ["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"] },
    { source: "npm", dirs: [p.join(home, ".npm-global", "bin")] },
  ];
}

function windowsCandidates(
  env: NodeJS.ProcessEnv,
  home: string,
  opts: LocateClaudeOptions
): Candidate[] {
  const w = path.win32;
  const profile = envValue(env, "USERPROFILE") || home;
  const appData = envValue(env, "APPDATA") || w.join(profile, "AppData", "Roaming");
  const localAppData = envValue(env, "LOCALAPPDATA") || w.join(profile, "AppData", "Local");
  const winget = w.join(localAppData, "Microsoft", "WinGet");
  // The installers' own folders first (cheap stats); the registry (two spawns) last.
  return [
    { source: "native", dirs: [w.join(profile, ".local", "bin")] },
    { source: "npm", dirs: [w.join(appData, "npm")] },
    { source: "winget", dirs: [w.join(winget, "Links"), ...wingetPackageDirs(winget, opts)] },
    { source: "registry-path", get dirs() { return registryDirs(env, opts); } },
  ];
}

/** The desktop app's install and data folders (Squirrel, Microsoft Store/MSIX, macOS). */
function desktopAppPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === "darwin") {
    return ["/Applications/Claude.app", path.posix.join(home, "Applications", "Claude.app")];
  }
  if (platform !== "win32") return [];
  const w = path.win32;
  const profile = envValue(env, "USERPROFILE") || home;
  const appData = envValue(env, "APPDATA") || w.join(profile, "AppData", "Roaming");
  const localAppData = envValue(env, "LOCALAPPDATA") || w.join(profile, "AppData", "Local");
  return [
    w.join(localAppData, "AnthropicClaude"),
    w.join(localAppData, "Packages", DESKTOP_MSIX_FAMILY),
    w.join(appData, "Claude"),
  ];
}

/** The Microsoft Store / MSIX package family of the Claude desktop app. */
const DESKTOP_MSIX_FAMILY = "Claude_pzs8sxrjxfjjc";

/**
 * The desktop app's own `claude.exe` (Squirrel: %LOCALAPPDATA%\AnthropicClaude
 * and its app-<version> folders; MSIX: WindowsApps\Claude_<version>_<arch>__<id>).
 * Launched as Claude Code it opens the app instead, so it is skipped.
 */
function isDesktopAppExe(file: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  const dir = path.win32.dirname(file).toLowerCase();
  return /\\anthropicclaude(\\app-[^\\]+)?$/.test(dir) ||
    /\\windowsapps\\claude_[^\\]*__pzs8sxrjxfjjc(\\app)?$/.test(dir);
}

/**
 * `claude` on PATH, skipping the desktop app's exe. Spawned by name when it is
 * the first `claude` on PATH (as before); by full path when the desktop app's
 * comes first, since spawning by name would start the app.
 */
function locateOnPath(
  dirs: string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isExecutable: (file: string) => boolean
): ClaudeLocation | null {
  let skipped = false;
  for (const dir of dirs) {
    const file = findOnPath("claude", [dir], platform, env, isExecutable);
    if (!file) continue;
    if (isDesktopAppExe(file, platform)) { skipped = true; continue; }
    if (!skipped) return { command: "claude", source: "path" };
    return { command: file, source: "path", dir: pathFor(platform).dirname(file) };
  }
  return null;
}

function registryDirs(env: NodeJS.ProcessEnv, opts: LocateClaudeOptions): string[] {
  return (opts.registryPath ?? (() => readRegistryPath(env)))()
    .flatMap((value) => splitPath(expandWindowsVars(value, env), "win32"));
}

/** winget's own folders for Claude Code (Anthropic.ClaudeCode_<source hash>). */
function wingetPackageDirs(winget: string, opts: LocateClaudeOptions): string[] {
  const packages = path.win32.join(winget, "Packages");
  const list = opts.listDir ?? defaultListDir;
  return list(packages)
    .filter((name) => /^Anthropic\.ClaudeCode/i.test(name))
    .map((name) => path.win32.join(packages, name));
}

function findOnPath(
  name: string,
  dirs: string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isExecutable: (file: string) => boolean
): string | null {
  const p = pathFor(platform);
  const exts = platform === "win32"
    ? (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = p.join(dir, name + ext.toLowerCase());
      if (isExecutable(file)) return file;
    }
  }
  return null;
}

function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  return splitPath(env[pathKey(env, platform)] ?? "", platform);
}

function splitPath(value: string, platform: NodeJS.Platform): string[] {
  return value
    .split(platform === "win32" ? ";" : ":")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

/** Windows env names are case-insensitive, but a copied env object is not. */
function pathKey(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== "win32") return "PATH";
  return Object.keys(env).reverse().find((key) => key.toUpperCase() === "PATH") ?? "Path";
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** `%USERPROFILE%\.local\bin` → its value; unknown names stay as written. */
export function expandWindowsVars(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => envValue(env, name) ?? whole);
}

/** The Path values in `reg query` output (REG_SZ or REG_EXPAND_SZ). */
export function parseRegQueryPath(output: string): string | null {
  const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(output);
  return m ? m[1].trim() : null;
}

function readRegistryPath(env: NodeJS.ProcessEnv): string[] {
  // By full path: PATH is what may be broken here.
  const root = envValue(env, "SystemRoot") || envValue(env, "windir") || "C:\\Windows";
  const reg = path.win32.join(root, "System32", "reg.exe");
  const keys = [
    "HKCU\\Environment",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  ];
  const out: string[] = [];
  for (const key of keys) {
    try {
      const result = spawnSync(reg, ["query", key, "/v", "Path"], {
        encoding: "utf8", timeout: 2000, windowsHide: true,
      });
      const value = result.status === 0 ? parseRegQueryPath(result.stdout ?? "") : null;
      if (value) out.push(value);
    } catch {
      // No reg.exe (or not Windows): nothing more to search.
    }
  }
  return out;
}

function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function defaultIsExecutable(platform: NodeJS.Platform): (file: string) => boolean {
  return (file) => {
    try {
      if (!fs.statSync(file).isFile()) return false;
      if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

function defaultListDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
