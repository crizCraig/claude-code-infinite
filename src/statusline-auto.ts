/**
 * ccc's status line on by default (Craig, 2026-11-13): the first interactive run of a ccc
 * that has this (a fresh install or an upgrade) installs `ccc statusline` once, so the
 * session's MemTree link (🌿 tree) is always at the bottom of the screen.
 *
 * - No statusLine: ccc's is installed.
 * - A statusLine command of the user's own: it is wrapped (still runs, the link follows it)
 *   and the user is told once, with how to undo it (`ccc statusline uninstall`).
 * - settings.json is backed up before any change (installStatusline does that).
 * - Anything that could break a custom status line is skipped and the user told: settings
 *   that are not valid JSON, a statusLine that is not a command, `ccc` not on PATH (Claude
 *   Code would run `ccc statusline` and get nothing), or a failed write. Windows is skipped
 *   quietly (`ccc statusline install` is not supported there yet).
 *
 * Done once per ccc config dir, recorded in AUTO_MARKER whatever the outcome, so an
 * uninstall is never undone by a later run; nor is one made with an older ccc (settings.json
 * has ccc backups but no saved original). CCC_STATUSLINE_AUTO=0 turns it off.
 */
import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "./config.js";
import { STATUSLINE_COMMAND, installStatusline, statusLineWantsLink, type StatuslinePaths }
  from "./statusline.js";

export const AUTO_MARKER = "statusline-auto.json";
const UNDO = "Undo: ccc statusline uninstall.";

export interface AutoStatuslineOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Where the once-only record lives (ccc's config dir). */
  markerDir?: string;
  /** Whether Claude Code's shell can run `ccc` (defaults to a PATH search). */
  cccOnPath?: () => boolean;
}

/** Install or wrap the status line once; the line to tell the user, if any. */
export function autoInstallStatusline(
  paths: StatuslinePaths, options: AutoStatuslineOptions = {}
): string | undefined {
  const env = options.env ?? process.env;
  if (env.CCC_STATUSLINE_AUTO === "0") return undefined;
  const marker = path.join(options.markerDir ?? getConfigDir(), AUTO_MARKER);
  if (fs.existsSync(marker)) return undefined;
  const { outcome, notice } = decide(paths, options, env);
  writeMarker(marker, outcome);
  return notice;
}

function decide(
  paths: StatuslinePaths, options: AutoStatuslineOptions, env: NodeJS.ProcessEnv
): { outcome: string; notice?: string } {
  if ((options.platform ?? process.platform) === "win32") return { outcome: "skipped-windows" };
  if (statusLineWantsLink(paths.settings)) return { outcome: "already" };
  // Installed with an older ccc and uninstalled (which kept only the backups): stays off.
  if (!fs.existsSync(paths.saved) && hasBackups(paths.settings)) return { outcome: "uninstalled" };
  const current = readStatusLine(paths.settings);
  if (current === "unreadable") {
    return { outcome: "skipped-invalid", notice: skipped(`${paths.settings} is not valid JSON`) };
  }
  if (current !== undefined && !isCommand(current)) {
    return { outcome: "skipped-not-command", notice: skipped("your statusLine is not a command") };
  }
  if (!(options.cccOnPath ?? (() => onPath("ccc", env)))()) {
    return { outcome: "skipped-no-path",
      notice: skipped(`\`ccc\` is not on PATH, so "${STATUSLINE_COMMAND}" would not run`) };
  }
  const result = installStatusline(paths, options.platform);
  if (!result.ok) return { outcome: "failed", notice: skipped(result.message) };
  return current === undefined
    ? { outcome: "installed", notice: `ccc added this session's MemTree link (🌿 tree) to ` +
        `Claude Code's status line. ${UNDO}` }
    : { outcome: "wrapped", notice: "ccc added this session's MemTree link (🌿 tree) after " +
        `your status line, which still runs first (settings.json backed up). ${UNDO}` };
}

function skipped(why: string): string {
  return `ccc left your status line unchanged: ${why.replace(/\.+$/, "")}. To add the ` +
    "MemTree link yourself: ccc statusline install.";
}

/** Whether `ccc statusline install` or `uninstall` ever backed up this settings file. */
function hasBackups(settings: string): boolean {
  try {
    const name = `${path.basename(settings)}.ccc-backup-`;
    return fs.readdirSync(path.dirname(settings)).some((entry) => entry.startsWith(name));
  } catch {
    return false;
  }
}

/** The statusLine setting, undefined when there is none, "unreadable" for bad JSON. */
function readStatusLine(file: string): unknown {
  if (!fs.existsSync(file)) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return "unreadable";
    return (value as Record<string, unknown>).statusLine;
  } catch {
    return "unreadable";
  }
}

function isCommand(statusLine: unknown): boolean {
  const line = statusLine as { type?: unknown; command?: unknown } | null;
  return !!line && typeof line === "object" && line.type === "command" &&
    typeof line.command === "string" && line.command.trim() !== "";
}

/** Whether an executable `name` is in one of PATH's directories. */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      const candidate = path.join(dir, name);
      // A directory is "executable" (searchable) too; Codex r5 P2.
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return true;
    } catch {
      // Not here.
    }
  }
  return false;
}

function writeMarker(file: string, outcome: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ outcome, at: new Date().toISOString() })}\n`);
  } catch {
    // Unwritable config dir: tried again next run, which is harmless (install is idempotent).
  }
}
