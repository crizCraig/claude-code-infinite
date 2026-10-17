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
/** ccc's own subcommands, which start no Claude session. */
const SUBCOMMANDS = ["fetch", "memtree-mcp"];
const ENVIRONMENT_WORDS = ["local", "staging"];
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
//# sourceMappingURL=cli-args.js.map