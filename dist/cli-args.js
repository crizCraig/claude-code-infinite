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
//# sourceMappingURL=cli-args.js.map