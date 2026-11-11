/**
 * PROTOTYPE (proto/desktop-app): `ccc [staging|local] desktop <command>`.
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
import { locateClaude } from "./claude-locate.js";
import { desktopEnvLines, desktopPaths, installLaunchAgent, readDesktopState, registerDesktopMcp, setupDesktopFiles, startDesktopService, uninstallLaunchAgent, unregisterDesktopMcp, writeDesktopState, } from "./desktop-service.js";
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
        if (process.platform !== "darwin") {
            console.error("ccc desktop: the prototype supports macOS only.");
            return 1;
        }
        if (!deps.apiKey()) {
            console.error("ccc desktop: no MemTree API key saved yet: run `ccc` in a terminal once first.");
            return 1;
        }
        const state = await setupDesktopFiles(paths, deps.mode, {
            rotateToken: args.includes("--rotate-token"), rotateCa: args.includes("--rotate-ca"),
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
            console.log("A new CA was made: Desktop sessions started before now must be restarted.\n");
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
            console.log("not set up");
            return 1;
        }
        const answer = await fetch(`http://127.0.0.1:${state.port}/ccc-desktop/status`, {
            headers: { "x-ccc-proxy-token": state.token }, signal: AbortSignal.timeout(2_000),
        }).then(async (r) => (r.ok ? await r.json() : { status: r.status }), (err) => ({ error: String(err?.name ?? err) }));
        const up = "service" in answer && answer.service === "ccc-desktop" && typeof answer.sessions === "number";
        console.log(up
            ? `service up on 127.0.0.1:${state.port}, ${answer.sessions} active session(s); CA valid until ${state.notAfter}`
            : `service NOT answering correctly on 127.0.0.1:${state.port} (${JSON.stringify(answer)}): ` +
                "not running, or another program has the port, or its token differs from service.json");
        return up ? 0 : 1;
    }
    if (sub === "serve") {
        const state = readDesktopState(paths);
        const apiKey = deps.apiKey();
        if (!state || !apiKey) {
            console.error("ccc desktop serve: not set up, or no MemTree key.");
            return 1;
        }
        const service = await startDesktopService({
            paths, state, memtreeBaseUrl: deps.memtreeBaseUrl, apiKey,
            ...(process.env.CCC_PROXY_TRACE ? { tracePath: process.env.CCC_PROXY_TRACE } : {}),
            ...(process.env.CCC_ANTHROPIC_UPSTREAM ? { upstreamOrigin: process.env.CCC_ANTHROPIC_UPSTREAM } : {}),
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