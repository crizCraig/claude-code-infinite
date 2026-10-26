/** Wrapper-only command-line options consumed by `ccc` before Claude's `--`. */
export interface WrapperArgs {
    claudeArgs: string[];
    debug: boolean;
}
/** Whether Claude's own print mode was requested before its `--` separator. */
export declare function isPrintInvocation(args: string[]): boolean;
/**
 * `ccc --version` / `ccc -v` (alone, or after `local`/`staging`): answered by ccc itself,
 * with no MemTree key, proxy or session, so it works right after installing.
 */
export declare function isVersionRequest(args: readonly string[]): boolean;
/** ccc's own subcommands, which start no Claude session. */
declare const SUBCOMMANDS: readonly ["fetch", "memtree-mcp", "link"];
export type CccEnvironment = "production" | "staging" | "local";
/** The environment a leading `local`/`staging` word selects (else production). */
export declare function environmentOf(args: readonly string[]): CccEnvironment;
/**
 * A ccc subcommand and its arguments: the first word, or the word after
 * `local`/`staging` (`ccc staging memtree-mcp` is the same server as
 * `ccc memtree-mcp`; the environment is the proxy's, from its base URL).
 */
export declare function subcommandArgs(args: readonly string[]): {
    name: (typeof SUBCOMMANDS)[number];
    args: string[];
} | undefined;
/**
 * Consume ccc's own flags only before the conventional `--` separator. Values
 * after it are literal Claude arguments/prompts, even when they look like ccc
 * flags.
 */
export declare function parseWrapperArgs(args: string[]): WrapperArgs;
export type MemtreeLinkPlacement = "turn" | "message" | "stop" | "success" | "off";
export declare const MEMTREE_LINK_PLACEMENTS: readonly MemtreeLinkPlacement[];
/**
 * `CCC_MEMTREE_LINK`: where the MemTree page link is shown (see
 * ProxyOptions.memtreeLinkPlacement). Unset or unknown values fall back to
 * the proxy's default placement.
 */
export declare function memtreeLinkPlacementFromEnv(value: string | undefined): MemtreeLinkPlacement | undefined;
/**
 * `CCC_COMPACT_TARGET`: "500k" / "20000" sets every session's compaction
 * target; "off" starts every session with compaction off (the state
 * `/memtree-compact off` sets, for headless runs that cannot type it).
 * `value` is undefined when unset or invalid; `warning` explains an invalid one.
 */
export declare function compactTargetFromEnv(raw: string | undefined, parseTokens: (text: string) => number | undefined, minTokens: number): {
    value: number | null | undefined;
    warning?: string;
};
/**
 * `CCC_ANTHROPIC_UPSTREAM` (test-only, e.g. "http://127.0.0.1:8123"): where the proxy sends
 * Anthropic traffic instead of api.anthropic.com, for a local mock (scripts/long-session).
 * Claude Code's credentials flow through to it, so only a loopback http(s) origin is taken;
 * `value` is undefined when unset or refused, and `warning` explains a refused one.
 */
export declare function anthropicUpstreamFromEnv(raw: string | undefined): {
    value: string | undefined;
    warning?: string;
};
export {};
//# sourceMappingURL=cli-args.d.ts.map