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
export function statuslinePaths(env = process.env) {
    const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
    return { settings: path.join(claudeDir, "settings.json"),
        saved: path.join(getConfigDir(), "statusline.json") };
}
/** `ccc statusline [install|uninstall]`; returns the exit code. */
export async function statuslineMain(args, paths = statuslinePaths(), out = (text) => process.stdout.write(text)) {
    const command = args[0];
    if (command === "install")
        return report(installStatusline(paths), out);
    if (command === "uninstall")
        return report(uninstallStatusline(paths), out);
    if (command !== undefined) {
        out("Usage: ccc statusline [install|uninstall]\n");
        return 2;
    }
    out(renderStatusline(await readStdin(), paths));
    return 0;
}
/** The status line: the wrapped command's output, then the session's link. */
export function renderStatusline(input, paths, env = process.env) {
    const wrapped = savedStatusLine(paths.saved);
    const base = wrapped ? runWrapped(wrapped.command, input) : "";
    const segment = linkSegment(sessionIdOf(input), env, paths.links);
    if (!segment)
        return base;
    return base ? `${base}${STATUSLINE_SEPARATOR}${segment}` : segment;
}
/** ` 🌿 tree` linked to the session's page, or the URL; "" with no cached link. */
export function linkSegment(sessionId, env = process.env, dir) {
    const url = readStatusLink(sessionId, dir);
    if (!url)
        return "";
    const mode = env.CCC_STATUSLINE_LINK;
    const osc8 = mode === "osc8" || (mode !== "url" && terminalSupportsHyperlinks(env, { isTTY: true }));
    return osc8 ? `\x1b]8;;${url}\x1b\\${STATUSLINE_LABEL}\x1b]8;;\x1b\\` : url;
}
/**
 * Point Claude Code's statusLine at `ccc statusline`, saving the current one to wrap.
 * Re-running is harmless; a statusLine that is not a command is left alone.
 */
export function installStatusline(paths) {
    const settings = readSettings(paths.settings);
    if (!settings.ok)
        return { ok: false, message: settings.message };
    const current = settings.value.statusLine;
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
export function uninstallStatusline(paths) {
    const settings = readSettings(paths.settings);
    if (!settings.ok)
        return { ok: false, message: settings.message };
    if (!isOurs(settings.value.statusLine)) {
        return { ok: true, message: "ccc statusline is not installed; nothing changed." };
    }
    const saved = readJson(paths.saved);
    backup(paths.settings);
    if (saved?.statusLine && typeof saved.statusLine === "object") {
        settings.value.statusLine = saved.statusLine;
    }
    else {
        delete settings.value.statusLine;
    }
    writeJson(paths.settings, settings.value);
    try {
        fs.unlinkSync(paths.saved);
    }
    catch {
        // Nothing saved.
    }
    return { ok: true, message: `Restored ${paths.settings} statusLine.` };
}
function isOurs(statusLine) {
    const command = statusLine?.command;
    return typeof command === "string" && command.trim() === STATUSLINE_COMMAND;
}
/** The statusLine install saved, when it was a command to wrap (never ours). */
function savedStatusLine(file) {
    const saved = readJson(file)?.statusLine;
    return typeof saved?.command === "string" && saved.command.trim() !== STATUSLINE_COMMAND
        ? { command: saved.command } : undefined;
}
/** The wrapped command's stdout, trailing newlines trimmed ("" if it fails). */
function runWrapped(command, input) {
    const result = spawnSync(command, { input, shell: true, encoding: "utf-8",
        timeout: WRAPPED_TIMEOUT_MS, stdio: ["pipe", "pipe", "ignore"] });
    return typeof result.stdout === "string" ? result.stdout.replace(/[\r\n]+$/, "") : "";
}
function sessionIdOf(input) {
    try {
        return JSON.parse(input)?.session_id;
    }
    catch {
        return undefined;
    }
}
function readSettings(file) {
    if (!fs.existsSync(file))
        return { ok: true, value: {} };
    const value = readJson(file);
    return value && typeof value === "object" && !Array.isArray(value)
        ? { ok: true, value: value }
        : { ok: false, message: `${file} is not valid JSON; left unchanged.` };
}
function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf-8"));
    }
    catch {
        return undefined;
    }
}
/** Write-then-rename, so Claude Code never reads a half-written settings file. */
function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(tmp, file);
}
function backup(file) {
    if (!fs.existsSync(file))
        return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(file, `${file}.ccc-backup-${stamp}`);
}
function report(result, out) {
    out(`${result.message}\n`);
    return result.ok ? 0 : 1;
}
async function readStdin() {
    if (process.stdin.isTTY)
        return "";
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf-8");
}
//# sourceMappingURL=statusline.js.map