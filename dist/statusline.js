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
import { spawn, spawnSync } from "node:child_process";
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
/** After SIGTERM, how long the wrapped command's group gets before SIGKILL. */
const KILL_GRACE_MS = 500;
/**
 * Set for the wrapped command: a `ccc statusline` inside it (a wrapped command that itself
 * calls ccc's, under another spelling) prints nothing instead of recursing.
 */
export const WRAPPED_ENV = "CCC_STATUSLINE_WRAPPED";
/** A command that runs ccc's status line, however ccc is spelled (path, npx, a shell). */
const CCC_STATUSLINE = /(^|[\s/\\'"])(ccc|claude-code-infinite)(\.cmd|\.js)?['"]?\s+statusline\b/;
export function statuslinePaths(env = process.env) {
    const dir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
    const settings = path.join(dir, "settings.json");
    // One saved original per settings file, however it is reached (aliases, symlinks).
    const resolved = resolvedPath(settings);
    const key = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
    return { settings, saved: path.join(getConfigDir(), `statusline-${key}.json`) };
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
    out(await renderStatusline(await readStdin(), paths));
    return 0;
}
/** The status line: the wrapped command's output, then the session's link. */
export async function renderStatusline(input, paths, env = process.env) {
    if (env[WRAPPED_ENV])
        return "";
    const wrapped = savedStatusLine(savedFile(paths));
    const base = wrapped ? await runWrapped(wrapped.command, input) : "";
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
export function installStatusline(paths, platform = process.platform) {
    // Claude Code runs a statusLine through Git Bash there; ccc would run it under cmd.exe.
    if (platform === "win32") {
        return { ok: false, message: "ccc statusline install is not supported on Windows yet. " +
                "Add the link with the snippet in ccc's README instead." };
    }
    const settings = readSettings(paths.settings);
    if (!settings.ok)
        return { ok: false, message: settings.message };
    const current = settings.value.statusLine;
    if (isOurs(current)) {
        return { ok: true, message: "ccc statusline is already installed. Restart Claude Code to see it." };
    }
    if (runsCccStatusline(current)) {
        return { ok: false, message: `${paths.settings}: your statusLine already runs ccc statusline; ` +
                "left unchanged." };
    }
    if (current !== undefined && (typeof current !== "object" || current.type !== "command" ||
        typeof current.command !== "string")) {
        return { ok: false, message: `${paths.settings}: statusLine is not a command; left unchanged.` };
    }
    const failed = attempt(() => {
        writeJson(paths.saved, { settings: paths.settings, resolved: resolvedPath(paths.settings),
            statusLine: current ?? null });
        backup(paths.settings);
        // Its other options (padding, refreshInterval, hideVimModeIndicator, ...) stay.
        settings.value.statusLine = { ...current, type: "command", command: STATUSLINE_COMMAND };
        writeJson(paths.settings, settings.value);
    });
    if (failed)
        return { ok: false, message: `Could not install: ${failed}` };
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
    const file = savedFile(paths);
    const saved = readJson(file);
    // No record of what install replaced: guessing could delete the user's own status line.
    if (!saved || !("statusLine" in saved)) {
        return { ok: false, message: `No saved original for ${paths.settings} (${paths.saved}); ` +
                "set statusLine yourself." };
    }
    const failed = attempt(() => {
        backup(paths.settings);
        if (saved.statusLine && typeof saved.statusLine === "object") {
            // The original command back; options changed since install stay as they are now.
            const original = saved.statusLine;
            settings.value.statusLine = { ...settings.value.statusLine,
                type: original.type, command: original.command };
        }
        else {
            delete settings.value.statusLine;
        }
        writeJson(paths.settings, settings.value);
        fs.unlinkSync(file);
    });
    if (failed)
        return { ok: false, message: `Could not uninstall: ${failed}` };
    return { ok: true, message: `Restored ${paths.settings} statusLine.` };
}
/** Exactly what install writes: only this is ccc's to replace or remove. */
function isOurs(statusLine) {
    const command = statusLine?.command;
    return typeof command === "string" && command.trim() === STATUSLINE_COMMAND;
}
/** Any command that runs ccc's status line (never wrapped: it would recurse). */
function runsCccStatusline(statusLine) {
    const command = statusLine?.command;
    return typeof command === "string" && CCC_STATUSLINE.test(command.trim());
}
/** `run`'s error message, or undefined when it succeeded. */
function attempt(run) {
    try {
        run();
        return undefined;
    }
    catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}
/**
 * The saved original for this settings file: under its key, else (the file was turned into
 * a symlink, or replaced by a regular one, after install) the one that recorded its path.
 */
function savedFile(paths) {
    if (fs.existsSync(paths.saved))
        return paths.saved;
    const dir = path.dirname(paths.saved);
    const wanted = new Set([path.resolve(paths.settings), resolvedPath(paths.settings)]);
    try {
        for (const name of fs.readdirSync(dir)) {
            if (!/^statusline-[0-9a-f]+\.json$/.test(name))
                continue;
            const saved = readJson(path.join(dir, name));
            if ([saved?.settings, saved?.resolved].some((p) => typeof p === "string" && wanted.has(p))) {
                return path.join(dir, name);
            }
        }
    }
    catch {
        // No config dir yet.
    }
    return paths.saved;
}
/** The statusLine install saved, when it was a command to wrap (never ccc's own). */
function savedStatusLine(file) {
    const saved = readJson(file)?.statusLine;
    return typeof saved?.command === "string" && !CCC_STATUSLINE.test(saved.command)
        ? { command: saved.command } : undefined;
}
/**
 * The wrapped command's stdout, trailing newlines trimmed ("" if it fails). Run in its own
 * process group, so a timeout kills everything it started (no pile-up across refreshes).
 */
export function runWrapped(command, input, timeoutMs = WRAPPED_TIMEOUT_MS) {
    return new Promise((resolve) => {
        // Not detached: a new session would lose the controlling terminal (`stty size </dev/tty`).
        const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "ignore"],
            env: { ...process.env, [WRAPPED_ENV]: "1" } });
        const chunks = [];
        let done = false;
        const finish = (text) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            resolve(text);
        };
        const timer = setTimeout(() => {
            const tree = processTree(child.pid);
            killAll(tree, "SIGTERM");
            // Kept referenced: ccc waits the grace out so the forced kill is sent.
            setTimeout(() => {
                killAll(tree, "SIGKILL");
                child.stdout.destroy();
                child.unref();
            }, KILL_GRACE_MS);
            finish("");
        }, timeoutMs);
        child.stdout.on("data", (chunk) => chunks.push(chunk));
        child.on("error", () => finish(""));
        child.on("close", () => finish(Buffer.concat(chunks).toString("utf-8").replace(/[\r\n]+$/, "")));
        child.stdin.on("error", () => { });
        child.stdin.end(input);
    });
}
/** `pid` and every descendant (from `ps`; just `pid` where there is none, e.g. Windows). */
export function processTree(pid) {
    if (pid === undefined)
        return [];
    const children = new Map();
    if (process.platform !== "win32") {
        const listing = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf-8", timeout: 2_000 });
        for (const line of (listing.stdout ?? "").split("\n")) {
            const [child, parent] = line.trim().split(/\s+/).map(Number);
            if (!Number.isFinite(child) || !Number.isFinite(parent))
                continue;
            children.set(parent, [...(children.get(parent) ?? []), child]);
        }
    }
    const tree = [];
    const queue = [pid];
    while (queue.length) {
        const next = queue.shift();
        if (tree.includes(next))
            continue;
        tree.push(next);
        queue.push(...(children.get(next) ?? []));
    }
    return tree;
}
function killAll(pids, signal) {
    for (const pid of pids) {
        try {
            process.kill(pid, signal);
        }
        catch {
            // Already gone.
        }
    }
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
/**
 * Write-then-rename, so Claude Code never reads a half-written settings file. A symlink
 * (dotfile managers) is followed so the link stays, and the file keeps its mode (it can
 * hold secrets in `env`); a new file is owner-only.
 */
function writeJson(file, value) {
    const target = realTarget(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const mode = fileMode(target) ?? 0o600;
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
}
/** `file` with symlinks resolved, through its nearest existing ancestor if it is missing. */
function resolvedPath(file) {
    const missing = [];
    let current = path.resolve(file);
    for (;;) {
        try {
            return path.join(fs.realpathSync(current), ...missing.reverse());
        }
        catch {
            const parent = path.dirname(current);
            if (parent === current)
                return path.resolve(file);
            missing.push(path.basename(current));
            current = parent;
        }
    }
}
function realTarget(file) {
    try {
        return fs.realpathSync(file);
    }
    catch {
        return file;
    }
}
function fileMode(file) {
    try {
        return fs.statSync(file).mode & 0o777;
    }
    catch {
        return undefined;
    }
}
function backup(file) {
    if (!fs.existsSync(file))
        return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const copy = `${file}.ccc-backup-${stamp}`;
    fs.copyFileSync(file, copy);
    fs.chmodSync(copy, fileMode(realTarget(file)) ?? 0o600);
}
/**
 * Whether Claude Code's status line reads ccc's link (installed, or the README snippet):
 * only then does the proxy keep the link fresh in the background. Read at startup.
 */
export function statusLineWantsLink(settingsFile = statuslinePaths().settings) {
    const command = (readJson(settingsFile)
        ?.statusLine)?.command;
    return typeof command === "string" &&
        (CCC_STATUSLINE.test(command) || command.includes(".claude-code-infinite/statusline"));
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