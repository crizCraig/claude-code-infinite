/**
 * `ccc [staging|local] desktop <command>`: MemTree for the Claude desktop app's Code tab
 * (opt-in, macOS; plans/2026-11-10_PLAN_desktop_app.md).
 *
 *   setup      CA + leaf, token, port, Bash env file; launchd agent; MemTree MCP
 *              server in the user's Claude Code config; prints the lines to paste
 *              into the Claude desktop app's environment editor.
 *   env        prints those lines again.
 *   status     is the service up, how many sessions it serves.
 *   serve      the service itself (what launchd runs).
 *   uninstall  stops and removes all of the above (the pasted lines must be removed
 *              in Desktop by hand: until then those sessions can't reach the API).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigDir } from "./config.js";
import { claudeDesktopInstalled, locateClaude } from "./claude-locate.js";
import { anthropicUpstreamFromEnv } from "./cli-args.js";
import { sanitizedNoProxy } from "./https-proxy-session.js";
import { HTTPS_PROXY_MODE_ENV, httpsProxyModeDecision } from "./https-proxy-eligibility.js";
import { PROXY_TOKEN_HEADER } from "./memtree-mcp.js";
import { desktopEnvLines, desktopPaths, installLaunchAgent, readDesktopState, registerDesktopMcp, setupDesktopFiles, uninstallLaunchAgent, unregisterDesktopMcp, writeDesktopState, desktopLaunchdLabel, CA_ROTATE_BEFORE_MS, } from "./desktop-setup.js";
import { startDesktopService } from "./desktop-service.js";
const CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));
/**
 * A `claude` for `claude mcp ...`: the terminal one, else the desktop app's own copy.
 * Desktop keeps verified installs at `<version>/<checksum prefix>/claude`
 * (`.../claude.app/Contents/MacOS/claude` on macOS); older layouts had `<version>/claude`.
 */
export function claudeForConfig(root = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code")) {
    const terminal = locateClaude();
    if (terminal)
        return terminal.command;
    return desktopClaudeBinaries(root).at(-1);
}
/** Desktop's downloaded Claude Code binaries, oldest version first. */
export function desktopClaudeBinaries(root) {
    const isExe = (f) => {
        try {
            fs.accessSync(f, fs.constants.X_OK);
            return fs.statSync(f).isFile();
        }
        catch {
            return false;
        }
    };
    const dirs = (d) => {
        try {
            return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
        }
        catch {
            return [];
        }
    };
    const found = [];
    for (const version of dirs(root)) {
        const vdir = path.join(root, version);
        const candidates = [path.join(vdir, "claude"),
            ...dirs(vdir).flatMap((sub) => [
                path.join(vdir, sub, "claude"),
                path.join(vdir, sub, "claude.app", "Contents", "MacOS", "claude"),
            ])];
        const file = candidates.find(isExe);
        if (file)
            found.push({ version, file });
    }
    found.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
    return found.map((f) => f.file);
}
export async function runDesktopCommand(args, deps) {
    const paths = desktopPaths(getConfigDir(), deps.mode);
    const sub = args[0] ?? "help";
    if (sub === "setup") {
        const refused = await setupPreflight(deps);
        if (refused !== undefined) {
            console.error(`ccc desktop: ${refused}`);
            return 1;
        }
        const state = await setupDesktopFiles(paths, deps.mode, {
            rotateToken: args.includes("--rotate-token"), rotateCa: args.includes("--rotate-ca"),
            userExtraCaPem: userExtraCaPem(process.env),
            ...(process.env.CLAUDE_CONFIG_DIR?.trim()
                ? { claudeConfigDir: process.env.CLAUDE_CONFIG_DIR.trim() } : {}),
            userEnv: {
                ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
                ...(process.env.CLAUDE_ENV_FILE ? { CLAUDE_ENV_FILE: process.env.CLAUDE_ENV_FILE } : {}),
            },
        });
        let mcpFailure;
        if (!args.includes("--no-mcp")) {
            const claude = claudeForConfig();
            const result = claude ? registerDesktopMcp(claude) : { ok: false, reason: "no `claude` found (terminal or the desktop app's copy)" };
            if (!result.ok)
                mcpFailure = result.reason;
            state.mcpRegistered = result.ok;
            writeDesktopState(paths, state);
        }
        // After the state is final: the service reads it at start.
        if (!args.includes("--no-launchd")) {
            try {
                installLaunchAgent(deps.mode, paths, CLI_PATH);
            }
            catch (err) {
                console.error(`ccc desktop: the service could not be started: ${String(err?.message ?? err)}. ` +
                    `Try again, or run \`ccc desktop serve\` in a terminal to see why.`);
                return 1;
            }
        }
        if (state.caRotated) {
            console.log("A new certificate was made: Desktop sessions started before now must be " +
                "restarted.\n");
            if (args.includes("--no-launchd")) {
                console.log("Restart the service too (it still serves the old one): " +
                    `launchctl kickstart -k gui/$(id -u)/${desktopLaunchdLabel(deps.mode)}\n`);
            }
        }
        console.log(setupText(paths, state));
        if (mcpFailure) {
            console.error(`\nccc desktop: the MemTree MCP server was NOT registered: ${mcpFailure}. ` +
                "Compression works, but the memory tools will be missing.");
            return 2;
        }
        return 0;
    }
    if (sub === "env") {
        const state = readDesktopState(paths);
        if (!state) {
            console.error("ccc desktop: not set up: run `ccc desktop setup`.");
            return 1;
        }
        console.log(desktopEnvLines(paths, state).join("\n"));
        return 0;
    }
    if (sub === "status") {
        const state = readDesktopState(paths);
        if (!state) {
            console.log("ccc desktop is not set up: run `ccc desktop setup`.");
            return 1;
        }
        const health = await serviceHealth(state);
        const expiry = certificateExpiryText(deps.mode, state);
        console.log(health.up
            ? `service up on 127.0.0.1:${state.port}, ${health.sessions} active session(s); ` +
                `certificate valid until ${state.notAfter}`
            : serviceDownText(deps.mode, state, health.detail));
        if (expiry)
            console.log(expiry);
        return health.up && !expiry ? 0 : 1;
    }
    if (sub === "serve") {
        const state = readDesktopState(paths);
        const apiKey = deps.apiKey();
        if (!state || !apiKey) {
            console.error("ccc desktop serve: not set up, or no MemTree key.");
            return 1;
        }
        trimServiceLog(paths.log);
        const service = await startDesktopService({
            paths, state, memtreeBaseUrl: deps.memtreeBaseUrl, apiKey,
            ...(process.env.CCC_PROXY_TRACE ? { tracePath: process.env.CCC_PROXY_TRACE } : {}),
            ...upstreamOverride(process.env.CCC_ANTHROPIC_UPSTREAM),
        });
        // A stray rejection must not take down every routed session: log it and carry on.
        process.on("unhandledRejection", (err) => console.error(`${new Date().toISOString()} unhandled rejection: ${String(err)}`));
        const stop = () => { void service.close().then(() => process.exit(0)); };
        process.on("SIGTERM", stop);
        process.on("SIGINT", stop);
        return await new Promise(() => { });
    }
    if (sub === "uninstall") {
        uninstallLaunchAgent(deps.mode, paths);
        fs.rmSync(paths.dir, { recursive: true, force: true });
        const others = ["production", "staging", "local"].some((m) => m !== deps.mode && fs.existsSync(desktopPaths(getConfigDir(), m).state));
        const claude = claudeForConfig();
        if (claude)
            unregisterDesktopMcp(claude, others);
        console.log("Removed the ccc desktop service, its files and the MemTree MCP entry.\n" +
            "In the Claude desktop app, remove the ccc lines from your environment (or switch sessions to another environment).");
        return 0;
    }
    console.log("usage: ccc [staging|local] desktop setup|env|status|serve|uninstall");
    return sub === "help" ? 0 : 1;
}
/** Why setup can't go ahead (undefined: it can); asks for a MemTree key when none is saved. */
async function setupPreflight(deps) {
    if (process.platform !== "darwin")
        return "the desktop app mode supports macOS only for now.";
    const blocked = httpsProxyModeDecision({
        env: { ...process.env, [HTTPS_PROXY_MODE_ENV]: "1" }, platform: process.platform,
        claudeArgs: [], cwd: os.homedir(),
    });
    if (blocked.mode === "base-url" && blocked.requested) {
        return `Desktop sessions can't be routed through ccc here: ${blocked.reason}.`;
    }
    // Desktop passes the login shell's NO_PROXY on: one covering api.anthropic.com would send
    // those sessions straight to Anthropic, past MemTree, with compaction off (Codex r1 P2).
    const noProxy = Object.keys(sanitizedNoProxy(process.env));
    if (noProxy.length) {
        return `your ${noProxy.join(" and ")} covers api.anthropic.com, so Desktop sessions would ` +
            "skip ccc: remove that entry from your shell profile, then run setup again.";
    }
    if (!claudeDesktopInstalled()) {
        console.log("Note: the Claude desktop app wasn't found; setting up anyway.\n");
    }
    if (deps.apiKey())
        return undefined;
    const key = process.stdin.isTTY ? await deps.promptForKey?.() : undefined;
    return key ? undefined : "no MemTree API key saved yet: run `ccc desktop setup` in a terminal.";
}
/** Is the service answering on its port, with its token? */
export async function serviceHealth(state, timeoutMs = 2_000) {
    try {
        const r = await fetch(`http://127.0.0.1:${state.port}/ccc-desktop/status`, {
            headers: { [PROXY_TOKEN_HEADER]: state.token }, signal: AbortSignal.timeout(timeoutMs),
        });
        const body = r.ok ? await r.json() : {};
        if (body.service === "ccc-desktop" && typeof body.sessions === "number") {
            return { up: true, sessions: body.sessions };
        }
        return { up: false, detail: `port ${state.port} answered ${r.status}: another program, ` +
                "or a service with another token" };
    }
    catch (err) {
        const code = err?.cause?.code;
        return { up: false, detail: code === "ECONNREFUSED" ? "nothing is listening"
                : String(err?.name ?? err) };
    }
}
/** What a stopped service means for Desktop sessions, and how to get it back. */
export function serviceDownText(mode, state, detail) {
    const label = desktopLaunchdLabel(mode);
    const cmd = mode === "production" ? "ccc" : `ccc ${mode}`;
    return [
        `ccc desktop service is NOT running on 127.0.0.1:${state.port} (${detail}).`,
        "Claude desktop app sessions started from your ccc environment can't reach Claude until it",
        "is back: they show \"Unable to connect to API\". Other Desktop environments are unaffected.",
        `Restart it: launchctl kickstart -k gui/$(id -u)/${label}`,
        `See why it stopped: tail ${paths(mode).log}`,
        `Or run \`${cmd} desktop setup\` again, or switch those sessions to another environment.`,
    ].join("\n");
}
/**
 * One line for a terminal ccc start when this mode's desktop service is set up but not
 * answering (undefined otherwise). A loopback check, bounded at 300 ms.
 */
export async function desktopServiceDownLine(mode) {
    if (process.platform !== "darwin")
        return undefined;
    const state = readDesktopState(paths(mode));
    if (!state)
        return undefined;
    const expiry = certificateExpiryText(mode, state);
    if (expiry)
        return expiry;
    const health = await serviceHealth(state, 300);
    if (health.up)
        return undefined;
    const cmd = mode === "production" ? "ccc" : `ccc ${mode}`;
    return `ccc: the desktop app service isn't running, so Desktop sessions in your ccc ` +
        `environment can't reach Claude: run \`${cmd} desktop status\` for how to fix it.`;
}
/**
 * Test-only CCC_ANTHROPIC_UPSTREAM, held to the loopback as in terminal ccc: decrypted
 * conversations and Desktop's OAuth bearer must never go anywhere else (Codex r1 P1).
 */
function upstreamOverride(raw) {
    const { value, warning } = anthropicUpstreamFromEnv(raw);
    if (warning)
        console.error(warning);
    return value ? { upstreamOrigin: value } : {};
}
/** launchd appends to service.log forever: past 10 MB, start it afresh at each service start. */
function trimServiceLog(log) {
    try {
        if (fs.statSync(log).size > 10 * 1024 * 1024)
            fs.truncateSync(log, 0);
    }
    catch { /* none yet */ }
}
/**
 * The certificate lasts a year and only `setup` renews it: say so once it's within the
 * renewal window or past it (sessions then fail TLS). undefined while it's fine.
 */
export function certificateExpiryText(mode, state, now = Date.now()) {
    const left = Date.parse(state.notAfter) - now;
    if (!(left <= CA_ROTATE_BEFORE_MS))
        return undefined;
    const cmd = mode === "production" ? "ccc" : `ccc ${mode}`;
    return left <= 0
        ? `ccc desktop's certificate expired on ${state.notAfter}: Desktop sessions in your ccc ` +
            `environment fail to connect. Run \`${cmd} desktop setup\`, then restart those sessions.`
        : `ccc desktop's certificate expires on ${state.notAfter}: run \`${cmd} desktop setup\` ` +
            "to renew it (then restart open Desktop sessions).";
}
function paths(mode) {
    return desktopPaths(getConfigDir(), mode);
}
/** The user's NODE_EXTRA_CA_CERTS file (corporate CAs), kept in the pasted bundle. */
function userExtraCaPem(env) {
    if (!env.NODE_EXTRA_CA_CERTS)
        return "";
    try {
        return fs.readFileSync(env.NODE_EXTRA_CA_CERTS, "utf8");
    }
    catch {
        return "";
    }
}
function setupText(paths, state) {
    return [
        `ccc desktop service (${state.mode}) is running on 127.0.0.1:${state.port}.`,
        "",
        "In the Claude desktop app: Code tab > environment menu > add or edit a local environment,",
        "and paste these lines into its Environment variables box:",
        "",
        ...desktopEnvLines(paths, state).map((l) => `  ${l}`),
        "",
        "New sessions started from that environment get MemTree; others are unchanged.",
        "Print the lines again with `ccc desktop env`; undo everything with `ccc desktop uninstall`.",
    ].join("\n");
}
//# sourceMappingURL=desktop-command.js.map