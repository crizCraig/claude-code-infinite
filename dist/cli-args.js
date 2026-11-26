/**
 * Claude Code options that require a following argument value when passed
 * without `=`. Any `-p` / `--print` immediately after one of these is its
 * value (opening the interactive UI), not Claude Code's print flag.
 */
const CLAUDE_VALUE_OPTIONS = new Set([
    "-n", "--name",
    "--add-dir",
    "--agent",
    "--agents",
    "--allowedTools", "--allowed-tools",
    "--append-system-prompt", "--append-system-prompt-file",
    "--autocompact",
    "--betas",
    "--debug-file",
    "--disallowedTools", "--disallowed-tools",
    "--effort",
    "--environment",
    "--fallback-model",
    "--file",
    "--input-format",
    "--json-schema",
    "--max-budget-usd",
    "--max-turns",
    "--mcp-config",
    "--model",
    "--output-format",
    "--permission-mode",
    "--permission-prompt-tool",
    "--permission-prompts",
    "--plugin-dir",
    "--plugin-url",
    "--remote-control-session-name-prefix",
    "--session-id",
    "--setting-sources",
    "--settings",
    "--system-prompt", "--system-prompt-file",
    "--system-prompt-snapshot",
    "--tools",
]);
/** Whether `arg` is a Claude Code option that consumes the next argv element as its value. */
export function takesRequiredOptionValue(arg) {
    return CLAUDE_VALUE_OPTIONS.has(arg) || /^-[c]+n$/.test(arg);
}
/**
 * Whether Claude's own print mode (`-p` / `--print`) was requested before `--`.
 * Argument-aware and conservative: option values (e.g. `--model -p`, `-n -p`),
 * attached short-flag values or clusters (`-dmcp`, `-pc`), and anything after `--`
 * are not treated as print mode (matching Claude Code opening its interactive UI).
 */
export function isPrintInvocation(args) {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--")
            return false;
        if (arg === "-p" || arg === "--print")
            return true;
        if (takesRequiredOptionValue(arg)) {
            if (args[i + 1] === "--")
                return false;
            i++;
        }
    }
    return false;
}
/**
 * isPrintInvocation, plus forms it leaves to Claude: a combined short-flag
 * cluster with p among its leading letters (`-pc`, `-cp`, `-pr<id>`) or
 * `--print=…`, anywhere in the arguments. Conservative: for
 * choices that must never happen in print mode, such as opening a browser.
 */
export function mayBePrintInvocation(args) {
    // Every argument, `--` included: an option's value can be `--` itself
    // (`--append-system-prompt -- -cp`), so it need not end Claude's options.
    for (const arg of args) {
        if (arg === "--print" || arg.startsWith("--print="))
            return true;
        // Commander reads a cluster up to a flag that takes a value, the rest being
        // that value (`-pr<session-id>`, `-pdapi,http`): p among the leading letters.
        if (/^-[A-Za-z]*p/.test(arg))
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
const SUBCOMMANDS = ["fetch", "memtree-mcp", "link", "desktop"];
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
/**
 * `CCC_AGENT_BUDGET_TOKENS` ("200k") and `CCC_AGENT_TARGET_TOKENS` ("100k", default half the
 * budget): subagent lanes compress at their own, smaller budget to their own target, while
 * the main lane keeps the model budget. Off (undefined) unless the budget is set; the budget
 * must be at least twice `minTokens`, and a target outside [minTokens, budget) is ignored
 * (half the budget). `warnings` explains anything ignored.
 */
export function agentLaneBudgetFromEnv(budgetRaw, targetRaw, parseTokens, minTokens) {
    if (!budgetRaw || !budgetRaw.trim())
        return { value: undefined, warnings: [] };
    const budget = parseTokens(budgetRaw);
    if (budget === undefined || budget < 2 * minTokens) {
        return { value: undefined, warnings: [
                `ccc: ignoring CCC_AGENT_BUDGET_TOKENS=${budgetRaw} (use a token count of at least ` +
                    `${(2 * minTokens) / 1000}k)`,
            ] };
    }
    if (!targetRaw || !targetRaw.trim())
        return { value: { budget }, warnings: [] };
    const target = parseTokens(targetRaw);
    if (target === undefined || target < minTokens || target >= budget) {
        return { value: { budget }, warnings: [
                `ccc: ignoring CCC_AGENT_TARGET_TOKENS=${targetRaw} (use a token count from ` +
                    `${minTokens / 1000}k to under the agent budget); using half the agent budget`,
            ] };
    }
    return { value: { budget, target }, warnings: [] };
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