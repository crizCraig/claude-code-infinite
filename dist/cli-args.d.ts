/** Wrapper-only command-line options consumed by `ccc` before Claude's `--`. */
export interface WrapperArgs {
    claudeArgs: string[];
    debug: boolean;
}
/** Whether Claude's own print mode was requested before its `--` separator. */
export declare function isPrintInvocation(args: string[]): boolean;
/** ccc's own subcommands, which start no Claude session. */
declare const SUBCOMMANDS: readonly ["fetch", "memtree-mcp"];
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
export {};
//# sourceMappingURL=cli-args.d.ts.map