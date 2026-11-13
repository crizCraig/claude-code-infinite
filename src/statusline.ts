/**
 * `ccc statusline`: this session's MemTree link in Claude Code's status line.
 *
 * - `ccc statusline` is a status-line command: it reads Claude Code's JSON from stdin,
 *   runs the user's own status-line command (if `install` wrapped one) with the same
 *   input, and appends ` | 🌿 tree` (an OSC 8 link to the session's newest MemTree page;
 *   the bare URL where the terminal has no hyperlinks). It only reads the cached link the
 *   proxy writes (status-link.ts): never a server call, so the status line stays fast.
 * - `ccc statusline install` (opt-in) points Claude Code's `statusLine` at it, keeping the
 *   existing command, which it wraps rather than replaces; settings.json is backed up first.
 * - `ccc statusline uninstall` puts the original back.
 *
 * Loaded straight from cli.ts (no proxy, no update check): Claude Code runs a status line
 * after every message.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfigDir } from "./config.js";
import { terminalSupportsHyperlinks } from "./hooks.js";
import { readStatusLink } from "./status-link.js";

/** What `install` puts in settings.json. */
export const STATUSLINE_COMMAND = "ccc statusline";
/** The link's text where the terminal shows OSC 8 hyperlinks. */
export const STATUSLINE_LABEL = "🌿 tree";
export const STATUSLINE_SEPARATOR = " | ";
/** The wrapped command gets this long; Claude Code drops a slow status line anyway. */
const WRAPPED_TIMEOUT_MS = 5_000;
/**
 * Set for the wrapped command: a `ccc statusline` inside it (a wrapped command that itself
 * calls ccc's, under another spelling) prints nothing instead of recursing.
 */
export const WRAPPED_ENV = "CCC_STATUSLINE_WRAPPED";
/** A command that runs ccc's status line, however ccc is spelled (path, npx, a shell). */
const CCC_STATUSLINE = /(^|[\s/\\'"])(ccc|claude-code-infinite)(\.cmd|\.js)?['"]?\s+statusline\b/;

export interface StatuslinePaths {
  /** Claude Code's user settings (CLAUDE_CONFIG_DIR/settings.json or ~/.claude/settings.json). */
  settings: string;
  /** The wrapped original statusLine, saved by install (in ccc's config dir). */
  saved: string;
  /** The cached links (status-link.ts). */
  links?: string;
}

export function statuslinePaths(env: NodeJS.ProcessEnv = process.env): StatuslinePaths {
  const custom = env.CLAUDE_CONFIG_DIR?.trim();
  const settings = path.join(custom || path.join(os.homedir(), ".claude"), "settings.json");
  // One saved original per settings file (a CLAUDE_CONFIG_DIR has its own).
  const key = custom ? `-${createHash("sha256").update(settings).digest("hex").slice(0, 12)}` : "";
  return { settings, saved: path.join(getConfigDir(), `statusline${key}.json`) };
}

/** `ccc statusline [install|uninstall]`; returns the exit code. */
export async function statuslineMain(
  args: string[], paths = statuslinePaths(), out = (text: string) => process.stdout.write(text)
): Promise<number> {
  const command = args[0];
  if (command === "install") return report(installStatusline(paths), out);
  if (command === "uninstall") return report(uninstallStatusline(paths), out);
  if (command !== undefined) {
    out("Usage: ccc statusline [install|uninstall]\n");
    return 2;
  }
  out(renderStatusline(await readStdin(), paths));
  return 0;
}

/** The status line: the wrapped command's output, then the session's link. */
export function renderStatusline(
  input: string, paths: StatuslinePaths, env: NodeJS.ProcessEnv = process.env
): string {
  if (env[WRAPPED_ENV]) return "";
  const wrapped = savedStatusLine(paths.saved);
  const base = wrapped ? runWrapped(wrapped.command, input) : "";
  const segment = linkSegment(sessionIdOf(input), env, paths.links);
  if (!segment) return base;
  return base ? `${base}${STATUSLINE_SEPARATOR}${segment}` : segment;
}

/** ` 🌿 tree` linked to the session's page, or the URL; "" with no cached link. */
export function linkSegment(
  sessionId: unknown, env: NodeJS.ProcessEnv = process.env, dir?: string
): string {
  const url = readStatusLink(sessionId, dir);
  if (!url) return "";
  const mode = env.CCC_STATUSLINE_LINK;
  const osc8 = mode === "osc8" || (mode !== "url" && terminalSupportsHyperlinks(env, { isTTY: true }));
  return osc8 ? `\x1b]8;;${url}\x1b\\${STATUSLINE_LABEL}\x1b]8;;\x1b\\` : url;
}

/**
 * Point Claude Code's statusLine at `ccc statusline`, saving the current one to wrap.
 * Re-running is harmless; a statusLine that is not a command is left alone.
 */
export function installStatusline(
  paths: StatuslinePaths, platform: NodeJS.Platform = process.platform
): { ok: boolean; message: string } {
  // Claude Code runs a statusLine through Git Bash there; ccc would run it under cmd.exe.
  if (platform === "win32") {
    return { ok: false, message: "ccc statusline install is not supported on Windows yet. " +
      "Add the link with the snippet in ccc's README instead." };
  }
  const settings = readSettings(paths.settings);
  if (!settings.ok) return { ok: false, message: settings.message };
  const current = settings.value.statusLine as Record<string, unknown> | undefined;
  if (isOurs(current)) {
    return { ok: true, message: "ccc statusline is already installed. Restart Claude Code to see it." };
  }
  if (current !== undefined && (typeof current !== "object" || current.type !== "command" ||
      typeof current.command !== "string")) {
    return { ok: false, message: `${paths.settings}: statusLine is not a command; left unchanged.` };
  }
  writeJson(paths.saved, { statusLine: current ?? null });
  backup(paths.settings);
  const padding = typeof current?.padding === "number" ? { padding: current.padding } : {};
  settings.value.statusLine = { type: "command", command: STATUSLINE_COMMAND, ...padding };
  writeJson(paths.settings, settings.value);
  const kept = current ? " It runs your existing status line and adds the link." : "";
  return { ok: true, message: `Installed: ${paths.settings} statusLine is now ` +
    `"${STATUSLINE_COMMAND}".${kept} Undo: ccc statusline uninstall.` };
}

/** Put back the statusLine install replaced (or remove ours when there was none). */
export function uninstallStatusline(paths: StatuslinePaths): { ok: boolean; message: string } {
  const settings = readSettings(paths.settings);
  if (!settings.ok) return { ok: false, message: settings.message };
  if (!isOurs(settings.value.statusLine)) {
    return { ok: true, message: "ccc statusline is not installed; nothing changed." };
  }
  const saved = readJson(paths.saved) as { statusLine?: unknown } | undefined;
  backup(paths.settings);
  if (saved?.statusLine && typeof saved.statusLine === "object") {
    settings.value.statusLine = saved.statusLine;
  } else {
    delete settings.value.statusLine;
  }
  writeJson(paths.settings, settings.value);
  try {
    fs.unlinkSync(paths.saved);
  } catch {
    // Nothing saved.
  }
  return { ok: true, message: `Restored ${paths.settings} statusLine.` };
}

function isOurs(statusLine: unknown): boolean {
  const command = (statusLine as { command?: unknown } | undefined)?.command;
  return typeof command === "string" && CCC_STATUSLINE.test(command.trim());
}

/** The statusLine install saved, when it was a command to wrap (never ccc's own). */
function savedStatusLine(file: string): { command: string } | undefined {
  const saved = (readJson(file) as { statusLine?: { command?: unknown } } | undefined)?.statusLine;
  return typeof saved?.command === "string" && !CCC_STATUSLINE.test(saved.command)
    ? { command: saved.command } : undefined;
}

/** The wrapped command's stdout, trailing newlines trimmed ("" if it fails). */
function runWrapped(command: string, input: string): string {
  const result = spawnSync(command, { input, shell: true, encoding: "utf-8",
    timeout: WRAPPED_TIMEOUT_MS, stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, [WRAPPED_ENV]: "1" } });
  return typeof result.stdout === "string" ? result.stdout.replace(/[\r\n]+$/, "") : "";
}

function sessionIdOf(input: string): unknown {
  try {
    return (JSON.parse(input) as { session_id?: unknown } | null)?.session_id;
  } catch {
    return undefined;
  }
}

function readSettings(
  file: string
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (!fs.existsSync(file)) return { ok: true, value: {} };
  const value = readJson(file);
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ok: true, value: value as Record<string, unknown> }
    : { ok: false, message: `${file} is not valid JSON; left unchanged.` };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
}

/**
 * Write-then-rename, so Claude Code never reads a half-written settings file. A symlink
 * (dotfile managers) is followed so the link stays, and the file keeps its mode (it can
 * hold secrets in `env`); a new file is owner-only.
 */
function writeJson(file: string, value: unknown): void {
  const target = realTarget(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const mode = fileMode(target) ?? 0o600;
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
}

function realTarget(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

function fileMode(file: string): number | undefined {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return undefined;
  }
}

function backup(file: string): void {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const copy = `${file}.ccc-backup-${stamp}`;
  fs.copyFileSync(file, copy);
  fs.chmodSync(copy, fileMode(realTarget(file)) ?? 0o600);
}

/**
 * Whether Claude Code's status line reads ccc's link (installed, or the README snippet):
 * only then does the proxy keep the link fresh in the background. Read at startup.
 */
export function statusLineWantsLink(settingsFile = statuslinePaths().settings): boolean {
  const command = ((readJson(settingsFile) as { statusLine?: { command?: unknown } } | undefined)
    ?.statusLine)?.command;
  return typeof command === "string" &&
    (CCC_STATUSLINE.test(command) || command.includes(".claude-code-infinite/statusline"));
}

function report(result: { ok: boolean; message: string }, out: (text: string) => void): number {
  out(`${result.message}\n`);
  return result.ok ? 0 : 1;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}
