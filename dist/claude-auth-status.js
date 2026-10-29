/**
 * Claude Code's own answer to "am I signed in?": `claude auth status --json`
 * (Claude Code 2.x). Unlike the config-file guess in claude-auth.ts, it knows
 * where each OS keeps the credentials (macOS keychain, `.credentials.json` on
 * Linux and Windows), which env key or setting wins, and that nobody is signed
 * in at all, which the files cannot tell apart from "can't tell".
 *
 * Only four fields are read: loggedIn, authMethod, apiProvider and
 * subscriptionType (plus apiKeySource's name). The email, organization and
 * every other field are never parsed out or kept.
 */
import { spawn as spawnPlain } from "node:child_process";
import * as path from "node:path";
import spawn from "cross-spawn";
import { planFrom } from "./claude-auth.js";
/**
 * How the probe went: answered, ran but said nothing usable, too slow, no such
 * command, or not asked (the session's options change its sign-in).
 */
export const AUTH_PROBE_RESULTS = ["ok", "failed", "timeout", "unsupported", "skipped"];
/** A slow Windows npm shim starts node twice; Claude Code itself answers in ~0.1 s. */
export const AUTH_PROBE_TIMEOUT_MS = 5000;
const MAX_OUTPUT = 64 * 1024;
/**
 * Session options that change which credentials Claude Code uses (an
 * apiKeyHelper in --settings, --bare's key-only sign-in). `claude auth status`
 * takes none of them, so its answer would not be this session's.
 */
const SESSION_AUTH_OPTIONS = ["--settings", "--setting-sources", "--bare"];
/** False when the session's own options may sign it in differently than the probe sees. */
export function probeAnswersForSession(args) {
    return !args.some((arg) => SESSION_AUTH_OPTIONS.some((option) => arg === option || arg.startsWith(`${option}=`)));
}
/** The probe for a session it can't answer for: the config files decide, nothing blocks. */
export function skippedProbe() {
    return { result: "skipped", ms: 0 };
}
/** Run `claude auth status --json`; never throws or rejects, and is bounded by timeoutMs. */
export function probeClaudeAuthStatus(command, opts = {}) {
    const now = opts.now ?? Date.now;
    const started = now();
    return new Promise((resolve) => {
        let out = "";
        let done = false;
        const finish = (result, status) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            process.removeListener("exit", onExit);
            stopSignals();
            resolve({ result, ms: Math.max(0, now() - started), ...(status ? { status } : {}) });
        };
        const child = startProbe(command, opts);
        // Detached on POSIX, so the terminal's Ctrl+C no longer reaches it: ccc exiting early
        // (a quit at the key prompt) takes a still-running probe with it.
        const onExit = () => { if (child)
            killTree(child); };
        process.once("exit", onExit);
        const stopSignals = killOnSignals(onExit);
        const timer = setTimeout(() => {
            finish("timeout");
            if (child)
                killTree(child);
        }, opts.timeoutMs ?? AUTH_PROBE_TIMEOUT_MS);
        if (!child)
            return finish("failed");
        child.stdout?.on("data", (chunk) => {
            if (out.length < MAX_OUTPUT)
                out += chunk.toString("utf8");
        });
        child.on("error", () => finish("failed"));
        child.on("close", () => {
            const status = parseAuthStatus(out, opts.env ?? process.env);
            finish(status ? "ok" : probeFailure(out), status);
        });
    });
}
/** The sign-in from `claude auth status --json` output, or undefined when it is not that. */
export function parseAuthStatus(stdout, env = process.env) {
    const json = jsonObject(stdout);
    if (!json || typeof json.loggedIn !== "boolean" || typeof json.authMethod !== "string") {
        return undefined;
    }
    const keySource = apiKeySource(json.apiKeySource);
    const consoleLogin = json.apiKeySource === "/login managed key";
    const base = { console: consoleLogin, ...(keySource ? { keySource } : {}) };
    // A signed-out cloud gateway is not "no Claude plan": ccc can't tell, so it doesn't say.
    if (!json.loggedIn) {
        return json.apiProvider === "firstParty" || json.apiProvider === undefined
            ? { auth: "none", plan: "unknown", ...base } : { auth: "unknown", plan: "unknown", ...base };
    }
    const cloud = cloudProvider(json.apiProvider);
    if (cloud)
        return { auth: cloud, plan: "unknown", ...base };
    if (json.authMethod === "oauth_token" && nonEmpty(env.ANTHROPIC_AUTH_TOKEN)) {
        // ANTHROPIC_AUTH_TOKEN wins over every other token in Claude Code: a bearer key.
        return { auth: "api_key", plan: "unknown", ...base, keySource: "ANTHROPIC_AUTH_TOKEN" };
    }
    return { ...authFromMethod(json.authMethod, json.subscriptionType), ...base };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function startProbe(command, opts) {
    try {
        return spawn(command, [...(opts.leadingArgs ?? []), "auth", "status", "--json"], {
            env: opts.env ?? process.env,
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
            // Its own process group on POSIX, so a timeout can kill it and its children.
            detached: process.platform !== "win32",
        });
    }
    catch {
        return undefined;
    }
}
const FATAL_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
/**
 * While the probe runs: on a fatal signal, kill it, then let the signal act as it
 * would have (re-raised when no other handler of ccc's takes it). Returns the undo.
 */
function killOnSignals(kill) {
    const handlers = FATAL_SIGNALS.map((signal) => {
        const handler = () => {
            kill();
            stop();
            if (process.listenerCount(signal) === 0)
                process.kill(process.pid, signal);
        };
        process.once(signal, handler);
        return [signal, handler];
    });
    const stop = () => {
        for (const [signal, handler] of handlers)
            process.removeListener(signal, handler);
    };
    return stop;
}
/**
 * Kill a timed-out probe and everything it started, never throwing. Windows:
 * taskkill /T /F (a .cmd shim runs cmd.exe, then node). POSIX: SIGKILL to its
 * process group, then to the process itself in case the group is gone.
 */
function killTree(child) {
    const pid = child.pid;
    if (pid === undefined)
        return;
    try {
        if (process.platform === "win32") {
            const root = process.env.SystemRoot ?? "C:\\Windows";
            spawnPlain(path.join(root, "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
            return;
        }
        process.kill(-pid, "SIGKILL");
    }
    catch {
        try {
            child.kill("SIGKILL");
        }
        catch { /* already gone */ }
    }
}
/** Older Claude Code has no `auth` command: it prints help or an error, never JSON. */
function probeFailure(stdout) {
    return stdout.trim().startsWith("{") ? "failed" : "unsupported";
}
function authFromMethod(method, subscriptionType) {
    const type = typeof subscriptionType === "string" ? subscriptionType : undefined;
    if (method === "claude.ai")
        return { auth: "subscription", plan: planFrom(type, undefined) };
    // setup-token, a host-provided token, a token file or a profile login: a Claude login.
    if (method === "oauth_token")
        return { auth: "subscription", plan: "unknown" };
    if (method === "api_key" || method === "api_key_helper") {
        return { auth: "api_key", plan: "unknown" };
    }
    return { auth: "unknown", plan: "unknown" };
}
function cloudProvider(provider) {
    if (provider === "bedrock" || provider === "vertex" || provider === "foundry")
        return provider;
    return undefined;
}
function apiKeySource(source) {
    if (source === "ANTHROPIC_API_KEY" || source === "ANTHROPIC_AUTH_TOKEN")
        return source;
    if (source === "apiKeyHelper")
        return "apiKeyHelper";
    return undefined;
}
function nonEmpty(value) {
    return typeof value === "string" && value.trim() !== "";
}
function jsonObject(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end < start)
        return undefined;
    try {
        const value = JSON.parse(text.slice(start, end + 1));
        return value && typeof value === "object" ? value : undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=claude-auth-status.js.map