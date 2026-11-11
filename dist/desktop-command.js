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
import { desktopEnvLines, desktopPaths, installLaunchAgent, readDesktopState, registerDesktopMcp, setupDesktopFiles, startDesktopService, uninstallLaunchAgent, unregisterDesktopMcp, } from "./desktop-service.js";
const CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));
/** A `claude` for `claude mcp ...`: the terminal one, else the desktop app's own copy. */
export function claudeForConfig() {
    const terminal = locateClaude();
    if (terminal)
        return terminal.command;
    const root = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code");
    try {
        const versions = fs.readdirSync(root).filter((v) => fs.existsSync(path.join(root, v, "claude")));
        versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        const newest = versions.at(-1);
        return newest ? path.join(root, newest, "claude") : undefined;
    }
    catch {
        return undefined;
    }
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
        const state = await setupDesktopFiles(paths, deps.mode, { rotateToken: args.includes("--rotate-token") });
        if (!args.includes("--no-launchd"))
            installLaunchAgent(deps.mode, paths, CLI_PATH);
        if (!args.includes("--no-mcp")) {
            const claude = claudeForConfig();
            if (!claude || !registerDesktopMcp(claude)) {
                console.error("ccc desktop: could not register the MemTree MCP server (no `claude` found); memory tools will be missing.");
            }
        }
        console.log(setupText(paths, state));
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
        const up = await fetch(`http://127.0.0.1:${state.port}/ccc-desktop/status`, {
            headers: { "x-ccc-proxy-token": state.token },
        }).then(() => true, () => false);
        console.log(`service ${up ? "listening" : "NOT listening"} on 127.0.0.1:${state.port}; CA valid until ${state.notAfter}`);
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
        const stop = () => { void service.close().then(() => process.exit(0)); };
        process.on("SIGTERM", stop);
        process.on("SIGINT", stop);
        return await new Promise(() => { });
    }
    if (sub === "uninstall") {
        uninstallLaunchAgent(deps.mode, paths);
        const claude = claudeForConfig();
        if (claude)
            unregisterDesktopMcp(claude);
        fs.rmSync(paths.dir, { recursive: true, force: true });
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