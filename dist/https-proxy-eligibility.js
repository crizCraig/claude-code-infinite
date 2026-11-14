/**
 * Whether this session runs in HTTPS-proxy mode (https-proxy-mode.ts) or in today's
 * base-URL mode. Opt-in: `CCC_HTTPS_PROXY_MODE=1` (or `=0` to force it off), else the
 * `httpsProxyMode` config key. Even when asked for, it is skipped, with one line saying
 * why, wherever it can't work yet (plans/2026-11-08_PLAN_https_proxy_remote_control.md,
 * section 5):
 *
 * - Windows: Claude Code's PowerShell tool doesn't apply the Bash env file.
 * - A proxy in ccc's own environment: blind tunnels and ccc's upstream would bypass it.
 * - Claude Code settings (user, project, local, managed, or a `--settings` argument)
 *   whose `env` sets a proxy, NO_PROXY or NODE_EXTRA_CA_CERTS: settings env overrides
 *   the process env, so model calls would skip MemTree silently or fail TLS.
 * - Claude Code's Bash sandbox enabled in any of those settings: its proxy forwards
 *   through Claude Code's HTTPS_PROXY (with the token), so sandboxed calls to
 *   api.anthropic.com would hit the interception and fail, and the sandbox's
 *   private-address check would not apply.
 *
 * These are read once, at startup: enabling the sandbox or a settings proxy mid-session
 * isn't seen here (https-proxy-session.ts warns when prompts then get no model call).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
export const HTTPS_PROXY_MODE_ENV = "CCC_HTTPS_PROXY_MODE";
/** A proxy in any of these (either case) means the user already routes through one. */
const PROXY_VARS = [
    "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy",
];
/**
 * Settings `env` keys that would override what proxy mode gives Claude Code. A settings
 * CLAUDE_ENV_FILE would replace the Bash env file, so Bash commands would keep the token
 * proxy and the session CA.
 */
const SETTINGS_ENV_BLOCKERS = [
    ...PROXY_VARS, "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "CLAUDE_ENV_FILE",
];
export function httpsProxyModeDecision(input) {
    if (!httpsProxyModeRequested(input.env, input.configured)) {
        return { mode: "base-url", requested: false };
    }
    const reason = blockingReason(input);
    return reason === undefined
        ? { mode: "https-proxy" }
        : { mode: "base-url", requested: true, reason };
}
/** `CCC_HTTPS_PROXY_MODE` wins (1/true/yes/on or 0/false/no/off), else the config key. */
export function httpsProxyModeRequested(env, configured) {
    const value = env[HTTPS_PROXY_MODE_ENV]?.trim().toLowerCase();
    if (value && ["1", "true", "yes", "on"].includes(value))
        return true;
    if (value && ["0", "false", "no", "off"].includes(value))
        return false;
    return configured === true;
}
/** The one-line notice for a requested mode that was skipped. */
export function skippedNoticeText(reason) {
    return `ccc: HTTPS-proxy mode (Remote Control) is off for this session: ${reason}. ` +
        "Using the base-URL mode.";
}
function blockingReason(input) {
    if (input.platform === "win32")
        return "Windows isn't supported yet";
    const own = PROXY_VARS.find((name) => nonEmpty(input.env[name]));
    if (own)
        return `${own} is already set (ccc can't chain to your proxy yet)`;
    const readFile = input.readFile ?? readTextFile;
    for (const source of settingsSources(input, readFile)) {
        const reason = settingsBlocker(source.settings);
        if (reason)
            return `${reason} in ${source.name}`;
    }
    return undefined;
}
function settingsBlocker(settings) {
    if (!isRecord(settings))
        return undefined;
    const sandbox = settings.sandbox;
    if (isRecord(sandbox) && sandbox.enabled === true)
        return "Claude Code's Bash sandbox is on";
    const env = settings.env;
    if (!isRecord(env))
        return undefined;
    // Present at all, even empty: a settings value replaces the process env's (an empty
    // HTTPS_PROXY would send Claude Code straight to api.anthropic.com, past MemTree).
    const key = SETTINGS_ENV_BLOCKERS.find((name) => Object.hasOwn(env, name));
    return key ? `${key} is set` : undefined;
}
/** Every settings scope Claude Code may load for this session, parsed; unreadable ones skipped. */
function settingsSources(input, readFile) {
    const files = [
        ...userSettingsFiles(input.env, input.homedir),
        ...projectSettingsFiles(input.cwd),
        ...managedSettingsFiles(input.platform, input.listDir ?? listJsonFiles),
    ];
    const out = [];
    for (const file of files) {
        const settings = parseJson(readFile(file));
        if (settings !== undefined)
            out.push({ name: file, settings });
    }
    for (const value of settingsArgs(input.claudeArgs)) {
        const inline = value.trim().startsWith("{");
        const settings = parseJson(inline ? value : readFile(path.resolve(input.cwd, value)));
        if (settings !== undefined)
            out.push({ name: "--settings", settings });
    }
    return out;
}
function userSettingsFiles(env, homedir) {
    const dir = nonEmpty(env.CLAUDE_CONFIG_DIR)
        ? env.CLAUDE_CONFIG_DIR
        : path.join(homedir ?? os.homedir(), ".claude");
    return [path.join(dir, "settings.json"), path.join(dir, "settings.local.json")];
}
/** `.claude/settings{,.local}.json` from the cwd up to its git root (or the filesystem root). */
function projectSettingsFiles(cwd) {
    const files = [];
    let dir = path.resolve(cwd);
    for (;;) {
        files.push(path.join(dir, ".claude", "settings.json"), path.join(dir, ".claude", "settings.local.json"));
        const parent = path.dirname(dir);
        if (parent === dir || existsSync(path.join(dir, ".git")))
            return files;
        dir = parent;
    }
}
function managedSettingsFiles(platform, listDir) {
    const dir = platform === "darwin"
        ? "/Library/Application Support/ClaudeCode"
        : "/etc/claude-code";
    const dropIns = path.join(dir, "managed-settings.d");
    return [
        path.join(dir, "managed-settings.json"),
        ...listDir(dropIns).map((name) => path.join(dropIns, name)),
        // macOS MDM profiles (managed preferences), machine-wide or for this user.
        ...(platform === "darwin" ? [
            `/Library/Managed Preferences/${MDM_DOMAIN}.plist`,
            `/Library/Managed Preferences/${userName()}/${MDM_DOMAIN}.plist`,
        ] : []),
    ];
}
const MDM_DOMAIN = "com.anthropic.claudecode";
function userName() {
    try {
        return os.userInfo().username;
    }
    catch {
        return process.env.USER ?? "";
    }
}
/** Every `--settings <value>` / `--settings=<value>` before a `--`. */
export function settingsArgs(args) {
    const out = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--")
            break;
        if (arg === "--settings" && i + 1 < args.length)
            out.push(args[++i]);
        else if (arg.startsWith("--settings="))
            out.push(arg.slice("--settings=".length));
    }
    return out;
}
function listJsonFiles(dir) {
    try {
        return readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
    }
    catch {
        return [];
    }
}
/** A settings file's text; a property list (MDM) as JSON through plutil. */
function readTextFile(file) {
    try {
        if (!file.endsWith(".plist"))
            return readFileSync(file, "utf8");
        if (!existsSync(file))
            return null;
        return execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
    }
    catch {
        return null;
    }
}
/** JSON as Claude Code reads settings: a leading byte-order mark is allowed. */
function parseJson(text) {
    if (text === null)
        return undefined;
    try {
        return JSON.parse(text.replace(/^\uFEFF/, ""));
    }
    catch {
        return undefined;
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmpty(value) {
    return typeof value === "string" ? value.trim() !== "" : value !== undefined && value !== null;
}
//# sourceMappingURL=https-proxy-eligibility.js.map