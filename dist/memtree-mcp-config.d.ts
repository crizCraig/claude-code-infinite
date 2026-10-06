/** `x-memtree-tools` value. */
export declare const MEMTREE_TOOLS_HEADER_VALUE: string;
/** Claude Code's names for the tools, for `--allowedTools`. */
export declare const MEMTREE_ALLOWED_TOOLS: string[];
export declare const MEMTREE_MCP_SCRIPT: string;
export declare function memtreeMcpEnabledByEnv(env: NodeJS.ProcessEnv): boolean;
/** The `--mcp-config` JSON for this ccc's server, bound to its proxy. */
export declare function memtreeMcpConfig(proxyUrl: string): object;
export interface MemtreeMcpConfigFile {
    path: string;
    close(): void;
}
export declare function writeMemtreeMcpConfig(proxyUrl: string, tempRoot?: string): MemtreeMcpConfigFile;
/** Prepend the options; `=` forms so no variadic option swallows user argv. */
export declare function withMemtreeMcpArgs(args: readonly string[], configPath: string): string[];
/**
 * The `--mcp-config` values in Claude's argv (before `--`): each is a file
 * path or an inline JSON string. Handles `--mcp-config a b` (variadic, up to
 * the next option) and `--mcp-config=a`.
 */
export declare function mcpConfigArgs(args: readonly string[]): string[];
/**
 * Whether Claude's argv already configures ccc's `memtree` server: a server
 * named `memtree` whose command line runs `memtree-mcp` (`ccc memtree-mcp` or
 * dist/memtree-mcp.js). Unreadable or malformed configs count as no.
 */
export declare function argsConfigureMemtreeMcp(args: readonly string[], cwd?: string): boolean;
//# sourceMappingURL=memtree-mcp-config.d.ts.map