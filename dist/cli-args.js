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
//# sourceMappingURL=cli-args.js.map