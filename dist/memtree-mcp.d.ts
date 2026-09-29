import { MemtreeIndex } from "./memtree-tools.js";
export declare const MEMTREE_MCP_SERVER_NAME = "memtree";
/** Sent to MemTree as `x-memtree-tools` when this server is configured. */
export declare const MEMTREE_TOOL_NAMES: readonly ["search", "read_node", "read_lines"];
/**
 * The MCP server's instructions, which Claude Code places in the system prompt
 * from the first request: the one place that explains the agent's situation
 * before any memory message exists. Constant, so the prompt cache holds.
 */
export declare const MEMTREE_MCP_INSTRUCTIONS: string;
export declare const MEMTREE_TOOLS: ({
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
            id?: undefined;
            block?: undefined;
            start?: undefined;
            end?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            id: {
                type: string;
                description: string;
            };
            query?: undefined;
            limit?: undefined;
            block?: undefined;
            start?: undefined;
            end?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            block: {
                type: string;
                description: string;
            };
            start: {
                type: string;
                description: string;
            };
            end: {
                type: string;
                description: string;
            };
            query?: undefined;
            limit?: undefined;
            id?: undefined;
        };
        required: string[];
    };
})[];
export interface MemtreeMcpDeps {
    /** The ccc loopback proxy, e.g. http://127.0.0.1:1234. */
    proxyUrl?: string;
    sessionId?: string;
    fetch?: typeof fetch;
}
/** Resolves, fetches and caches the current page. */
export declare class CurrentTree {
    private readonly deps;
    private cached?;
    private readonly fetchImpl;
    constructor(deps: MemtreeMcpDeps);
    get(): Promise<MemtreeIndex>;
    private getJson;
}
type JsonRpcId = string | number | null;
interface JsonRpcRequest {
    jsonrpc?: string;
    id?: JsonRpcId;
    method?: string;
    params?: Record<string, unknown>;
}
/**
 * One JSON-RPC message in, the response out (undefined for notifications).
 * Exposed for tests; the stdio loop below is only framing.
 */
export declare function handleMcpMessage(message: JsonRpcRequest, tree: {
    get(): Promise<MemtreeIndex>;
}): Promise<object | undefined>;
/** Serve MCP over this process's stdin/stdout until stdin closes. */
export declare function runMemtreeMcpServer(env?: NodeJS.ProcessEnv): void;
export {};
//# sourceMappingURL=memtree-mcp.d.ts.map