/** Whether Claude's own print mode was requested before its `--` separator. */
export function isPrintInvocation(args) {
    for (const arg of args) {
        if (arg === "--")
            return false;
        if (arg === "-p" || arg === "--print")
            return true;
    }
    return false;
}
/**
 * isPrintInvocation, plus forms it leaves to Claude: a combined short-flag
 * cluster containing p (`-pc`, `-cp`) or `--print=…`. Conservative: for
 * choices that must never happen in print mode, such as opening a browser.
 */
export function mayBePrintInvocation(args) {
    for (const arg of args) {
        if (arg === "--")
            return false;
        if (arg === "--print" || arg.startsWith("--print="))
            return true;
        if (/^-[A-Za-z]*p[A-Za-z]*$/.test(arg))
            return true;
    }
    return false;
}
/**
 * `ccc --version` / `ccc -v` (alone, or after `local`/`staging`): answered by ccc itself,
 * with no MemTree key, proxy or session, so it works right after installing.
 */
export function isVersionRequest(args) {
    const start = ENVIRONMENT_WORDS.includes(args[0] ?? "") ? 1 : 0;
    const rest = args.slice(start);
    return rest.length === 1 && (rest[0] === "--version" || rest[0] === "-v");
}
/** ccc's own subcommands, which start no Claude session. */
const SUBCOMMANDS = ["fetch", "memtree-mcp", "link"];
const ENVIRONMENT_WORDS = ["local", "staging"];
/** The environment a leading `local`/`staging` word selects (else production). */
export function environmentOf(args) {
    return args[0] === "local" ? "local" : args[0] === "staging" ? "staging" : "production";
}
/**
 * A ccc subcommand and its arguments: the first word, or the word after
 * `local`/`staging` (`ccc staging memtree-mcp` is the same server as
 * `ccc memtree-mcp`; the environment is the proxy's, from its base URL).
 */
export function subcommandArgs(args) {
    const start = ENVIRONMENT_WORDS.includes(args[0] ?? "") ? 1 : 0;
    const name = SUBCOMMANDS.find((command) => command === args[start]);
    return name ? { name, args: args.slice(start + 1) } : undefined;
}
/**
 * Consume ccc's own flags only before the conventional `--` separator. Values
 * after it are literal Claude arguments/prompts, even when they look like ccc
 * flags.
 */
export function parseWrapperArgs(args) {
    const claudeArgs = [];
    let beforeSeparator = true;
    let debug = false;
    for (const arg of args) {
        if (beforeSeparator && arg === "--") {
            beforeSeparator = false;
            claudeArgs.push(arg);
            continue;
        }
        if (beforeSeparator && arg === "--debug") {
            debug = true;
            continue;
        }
        claudeArgs.push(arg);
    }
    return { claudeArgs, debug };
}
export const MEMTREE_LINK_PLACEMENTS = [
    "turn",
    "message",
    "stop",
    "success",
    "off",
];
/**
 * `CCC_MEMTREE_LINK`: where the MemTree page link is shown (see
 * ProxyOptions.memtreeLinkPlacement). Unset or unknown values fall back to
 * the proxy's default placement.
 */
export function memtreeLinkPlacementFromEnv(value) {
    const normalized = value?.trim().toLowerCase();
    return MEMTREE_LINK_PLACEMENTS.includes(normalized ?? "")
        ? normalized
        : undefined;
}
/**
 * `CCC_COMPACT_TARGET`: "500k" / "20000" sets every session's compaction
 * target; "off" starts every session with compaction off (the state
 * `/memtree-compact off` sets, for headless runs that cannot type it).
 * `value` is undefined when unset or invalid; `warning` explains an invalid one.
 */
export function compactTargetFromEnv(raw, parseTokens, minTokens) {
    if (!raw || !raw.trim())
        return { value: undefined };
    if (/^off$/i.test(raw.trim()))
        return { value: null };
    const target = parseTokens(raw);
    if (target === undefined || target < minTokens) {
        return {
            value: undefined,
            warning: `ccc: ignoring CCC_COMPACT_TARGET=${raw} (use off, or a token count of at least ${minTokens / 1000}k)`,
        };
    }
    return { value: target };
}
/** Hosts `CCC_ANTHROPIC_UPSTREAM` may name: this machine only. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
/**
 * `CCC_ANTHROPIC_UPSTREAM` (test-only, e.g. "http://127.0.0.1:8123"): where the proxy sends
 * Anthropic traffic instead of api.anthropic.com, for a local mock (scripts/long-session).
 * Claude Code's credentials flow through to it, so only a loopback http(s) origin is taken;
 * `value` is undefined when unset or refused, and `warning` explains a refused one.
 */
export function anthropicUpstreamFromEnv(raw) {
    if (!raw || !raw.trim())
        return { value: undefined };
    let url;
    try {
        url = new URL(raw.trim());
    }
    catch {
        url = undefined;
    }
    const loopback = url !== undefined && /^https?:$/.test(url.protocol) &&
        LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password &&
        (url.pathname === "/" || url.pathname === "");
    if (!loopback) {
        return {
            value: undefined,
            // Never echo the value: a refused one may carry credentials.
            warning: "ccc: ignoring CCC_ANTHROPIC_UPSTREAM (only a loopback origin such as http://127.0.0.1:8123)",
        };
    }
    return { value: url.origin };
}
//# sourceMappingURL=cli-args.js.map