import { createRequire } from "node:module";
import { memtreeBaseUrlFor, storedApiKey } from "./config.js";
// These switches only suppress warnings, include their call stacks, or turn off
// the inspector signal. The one valued flag only sets a numeric V8 heap limit.
const DIRECT_NODE_SWITCHES = ["--no-warnings", "--trace-warnings", "--trace-deprecation"];
if (process.allowedNodeEnvironmentFlags.has("--disable-sigusr1"))
    DIRECT_NODE_SWITCHES.push("--disable-sigusr1");
function nodeOptionsArgs(options) {
    // Node splits on spaces outside double quotes. A backslash escapes the next
    // character only inside quotes. Leave all other characters literal.
    const args = [];
    let quoted = false;
    let arg = "";
    for (let i = 0; i < options.length; i++) {
        const c = options[i];
        if (c === '"')
            quoted = !quoted;
        else if (quoted && c === "\\")
            arg += options[++i] ?? "";
        else if (!quoted && c === " ") {
            if (arg)
                args.push(arg);
            arg = "";
        }
        else
            arg += c;
    }
    // Node normally rejects unterminated quotes before it reaches the entry point.
    if (quoted)
        throw new Error("Invalid quoting in NODE_OPTIONS.");
    if (arg)
        args.push(arg);
    return args;
}
function checkDirectNodeFlags(args, source) {
    for (const arg of args) {
        if (DIRECT_NODE_SWITCHES.includes(arg) || /^--(?:max-old-space-size|max_old_space_size)=[0-9]+$/.test(arg))
            continue;
        const name = /^-{1,2}[a-zA-Z0-9_-]+/.exec(arg)?.[0] ?? "(unnamed argument)";
        const fix = source === "NODE_OPTIONS"
            ? "Remove the flag from NODE_OPTIONS or clear NODE_OPTIONS in this MCP server's environment."
            : "Remove the flag from the Node command line.";
        throw new Error(`Unsupported Node flag ${name} in ${source}. ${fix} MemTree direct mode accepts only --max-old-space-size=N (or --max_old_space_size=N), ${DIRECT_NODE_SWITCHES.join(", ")}.`);
    }
}
export function directCredentials(mode, env) {
    if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
        throw new Error("MemTree direct mode requires TLS verification. Unset NODE_TLS_REJECT_UNAUTHORIZED=0.");
    }
    // Diagnostics can log raw traffic or capture the saved key from memory.
    if (env.NODE_DEBUG !== undefined) {
        throw new Error("Node diagnostics can expose the MemTree key in direct mode. Unset NODE_DEBUG.");
    }
    checkDirectNodeFlags(process.execArgv, "Node command line");
    checkDirectNodeFlags(nodeOptionsArgs(env.NODE_OPTIONS ?? ""), "NODE_OPTIONS");
    // Node 20 lacks --disable-sigusr1. Claim the signal before loading the key.
    if (process.platform !== "win32")
        process.on("SIGUSR1", () => { });
    // The inspector might already be listening. Some Node builds omit it entirely.
    if (process.features.inspector) {
        const inspector = createRequire(import.meta.url)("node:inspector");
        if (inspector.url()) {
            throw new Error("The Node inspector is already listening. Restart the MemTree MCP server with debugging disabled.");
        }
    }
    const savedKey = storedApiKey(mode, { warnOnLegacy: false });
    const apiKey = typeof savedKey === "string" ? savedKey.trim() : undefined;
    if (!apiKey) {
        throw new Error(`No MemTree key saved for ${mode}. Run ccc${mode === "staging" ? " staging" : ""} to save one.`);
    }
    return { baseUrl: memtreeBaseUrlFor(mode), apiKey };
}
//# sourceMappingURL=direct-credentials.js.map