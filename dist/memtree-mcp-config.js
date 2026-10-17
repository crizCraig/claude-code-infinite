/**
 * Registering the `memtree` MCP server (memtree-mcp.ts) with Claude Code, and
 * telling whether it is registered, which decides the `x-memtree-tools`
 * header on MemTree compress calls: MemTree then adds a short how-to naming
 * the tools to the memory it returns, so it must never be sent when the tools
 * are absent.
 *
 * - Every ccc session, interactive or print (`-p`) / non-TTY: ccc writes a
 *   one-server config to a temp dir and passes `--mcp-config=<file>`.
 *   `--mcp-config` (unlike a plugin's `.mcp.json`, whose tools Claude Code
 *   would name `mcp__plugin_ccc_…`) keeps the tool names `mcp__memtree__*` and
 *   still loads under a user's `--strict-mcp-config`. The `=` form matters:
 *   `--mcp-config` is variadic, and a following positional prompt would
 *   otherwise be read as a config. The tools are read-only views of the
 *   user's own sessions, so they are pre-allowed with `--allowedTools=` as
 *   well: Claude Code adds repeated `--allowedTools` lists together, so a
 *   caller's own list is kept and only these tools are added. The server sets
 *   Claude Code's `alwaysLoad: true`, so its tools are in the prompt from the
 *   first turn (and after --resume) instead of deferred behind tool search;
 *   this applies to this server only, not the user's other MCP servers.
 *   Claude Code also waits (up to its 5s connect timeout) for the server
 *   before that turn; it is a local Node process, so that is milliseconds.
 *   The server writes only to its own stdio pipe, so `-p` output (text, json,
 *   stream-json) is unchanged apart from what the model does with the tools.
 * - The caller's choices win (planMemtreeMcp): `CCC_MEMTREE_MCP=0` turns it
 *   off; a caller's own `--mcp-config` server named `memtree` (or a config
 *   ccc cannot read, which might define one) is kept and ccc adds and
 *   pre-allows nothing (if it runs `ccc memtree-mcp` the header is still
 *   sent); tools named by `--disallowedTools` (a tool, `mcp__memtree`,
 *   or a `*` pattern) are neither pre-allowed nor named in the header, and
 *   with all four disallowed ccc registers nothing. Claude Code applies a
 *   deny over an allow in any case.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MEMTREE_MCP_SERVER_NAME, MEMTREE_TOOL_NAMES, PROXY_VERSION_ENV, } from "./memtree-mcp.js";
import { CLIENT_VERSION } from "./memtree.js";
/** `x-memtree-tools` value. */
export const MEMTREE_TOOLS_HEADER_VALUE = MEMTREE_TOOL_NAMES.join(",");
/** Claude Code's names for the tools, for `--allowedTools`. */
export const MEMTREE_ALLOWED_TOOLS = MEMTREE_TOOL_NAMES.map(memtreeToolName);
export const MEMTREE_MCP_SCRIPT = fileURLToPath(new URL("./memtree-mcp.js", import.meta.url));
export function memtreeMcpEnabledByEnv(env) {
    return env.CCC_MEMTREE_MCP !== "0";
}
/** The `--mcp-config` JSON for this ccc's server, bound to its proxy. */
export function memtreeMcpConfig(proxyUrl) {
    return {
        mcpServers: {
            [MEMTREE_MCP_SERVER_NAME]: {
                type: "stdio",
                command: process.execPath,
                args: [MEMTREE_MCP_SCRIPT],
                // The proxy's version, so a server started after an update can tell.
                env: { CCC_MEMTREE_PROXY: proxyUrl, [PROXY_VERSION_ENV]: CLIENT_VERSION },
                alwaysLoad: true,
            },
        },
    };
}
export function writeMemtreeMcpConfig(proxyUrl, tempRoot = os.tmpdir()) {
    const dir = fs.mkdtempSync(path.join(tempRoot, "ccc-memtree-mcp-"));
    const file = path.join(dir, "mcp.json");
    fs.writeFileSync(file, JSON.stringify(memtreeMcpConfig(proxyUrl)), { mode: 0o600 });
    let closed = false;
    return {
        path: file,
        close() {
            if (closed)
                return;
            closed = true;
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}
/**
 * Whether ccc adds its `memtree` server to this Claude argv, and which tools
 * the session then has. The same for interactive and print/non-TTY runs.
 */
export function planMemtreeMcp(args, env, cwd = process.cwd()) {
    const disallowed = new Set(disallowedMemtreeTools(args));
    const tools = MEMTREE_TOOL_NAMES.filter((tool) => !disallowed.has(tool));
    const callerServer = memtreeServerInArgs(args, cwd);
    if (callerServer === "ccc")
        return { register: false, tools };
    if (callerServer !== "none" || !memtreeMcpEnabledByEnv(env) || tools.length === 0) {
        return { register: false, tools: [] };
    }
    return { register: true, tools };
}
/** Prepend the options; `=` forms so no variadic option swallows user argv. */
export function withMemtreeMcpArgs(args, configPath, tools = MEMTREE_TOOL_NAMES) {
    return [
        `--mcp-config=${configPath}`,
        `--allowedTools=${tools.map(memtreeToolName).join(",")}`,
        ...args,
    ];
}
/**
 * The memtree tools (bare names) that `--disallowedTools` /
 * `--disallowed-tools` rules in Claude's argv name: the tool itself, the
 * whole server (`mcp__memtree`), or a `*` pattern such as `mcp__memtree__*`.
 */
export function disallowedMemtreeTools(args) {
    const rules = optionValues(args, ["--disallowedTools", "--disallowed-tools"])
        .flatMap((value) => value.split(/[\s,]+/))
        .filter(Boolean);
    return MEMTREE_TOOL_NAMES.filter((tool) => rules.some((rule) => ruleMatchesMemtreeTool(rule, tool)));
}
/**
 * The `--mcp-config` values in Claude's argv (before `--`): each is a file
 * path or an inline JSON string. Handles `--mcp-config a b` (variadic, up to
 * the next option) and `--mcp-config=a`.
 */
export function mcpConfigArgs(args) {
    return optionValues(args, ["--mcp-config"]);
}
/**
 * The server named `memtree` in the argv's `--mcp-config` values, judged by
 * the last value that defines one (Claude Code keeps the last definition of
 * a name): "ccc" when it runs `memtree-mcp` (`ccc memtree-mcp`, `ccc staging
 * memtree-mcp`, or dist/memtree-mcp.js), "other" for someone else's, and
 * "unknown" when a value ccc cannot read or parse comes after it (it may
 * define one), "none" otherwise. Only `--mcp-config` can override ccc's
 * server: it beats a project `.mcp.json` server of the same name (checked on
 * Claude Code 2.1.302), and plugin servers get `plugin_…` names.
 */
export function memtreeServerInArgs(args, cwd = process.cwd()) {
    let found = "none";
    for (const value of mcpConfigArgs(args)) {
        const server = memtreeServerIn(value, cwd);
        if (server === null)
            continue;
        found = server === undefined ? "unknown" : isCccMemtreeServer(server) ? "ccc" : "other";
    }
    return found;
}
/** `--name value…` (variadic, up to the next option) and `--name=value`, before `--`. */
function optionValues(args, names) {
    const values = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--")
            break;
        const inline = names.find((name) => arg.startsWith(`${name}=`));
        if (inline) {
            values.push(arg.slice(inline.length + 1));
            continue;
        }
        if (!names.includes(arg))
            continue;
        while (i + 1 < args.length && !args[i + 1].startsWith("-"))
            values.push(args[++i]);
    }
    return values;
}
/**
 * The `memtree` entry of one `--mcp-config` value (file or inline JSON):
 * null when it defines none, undefined when it cannot be read or parsed.
 */
function memtreeServerIn(value, cwd) {
    let parsed;
    try {
        const text = value.trim().startsWith("{")
            ? value
            : fs.readFileSync(path.resolve(cwd, value), "utf-8");
        parsed = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    const server = parsed?.mcpServers?.[MEMTREE_MCP_SERVER_NAME];
    if (server === undefined)
        return null;
    return server && typeof server === "object" ? server : undefined;
}
/** A command line whose program or an argument is `memtree-mcp` or a memtree-mcp.js path. */
function isCccMemtreeServer(server) {
    const parts = [server.command, ...(Array.isArray(server.args) ? server.args : [])];
    return parts.some((part) => typeof part === "string" && /^memtree-mcp(\.js)?$/.test(path.basename(part)));
}
function memtreeToolName(tool) {
    return `mcp__${MEMTREE_MCP_SERVER_NAME}__${tool}`;
}
/** A permission rule naming this tool, its whole server, or a `*` pattern over it. */
function ruleMatchesMemtreeTool(rule, tool) {
    if (rule === `mcp__${MEMTREE_MCP_SERVER_NAME}`)
        return true;
    const pattern = rule.split("*").map(escapeRegExp).join(".*");
    return new RegExp(`^${pattern}$`).test(memtreeToolName(tool));
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
//# sourceMappingURL=memtree-mcp-config.js.map