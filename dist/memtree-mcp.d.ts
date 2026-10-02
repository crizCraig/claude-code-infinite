import { MemtreeIndex } from "./memtree-tools.js";
export declare const MEMTREE_MCP_SERVER_NAME = "memtree";
/** Sent to MemTree as `x-memtree-tools` when this server is configured. */
export declare const MEMTREE_TOOL_NAMES: readonly ["search", "read_node", "read_lines", "list_sessions", "search_sessions"];
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
            tree: {
                type: string;
                description: string;
            };
            id?: undefined;
            block?: undefined;
            start?: undefined;
            end?: undefined;
            since?: undefined;
            until?: undefined;
            project?: undefined;
            q?: undefined;
            cursor?: undefined;
            mode?: undefined;
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
            tree: {
                type: string;
                description: string;
            };
            query?: undefined;
            limit?: undefined;
            block?: undefined;
            start?: undefined;
            end?: undefined;
            since?: undefined;
            until?: undefined;
            project?: undefined;
            q?: undefined;
            cursor?: undefined;
            mode?: undefined;
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
            tree: {
                type: string;
                description: string;
            };
            query?: undefined;
            limit?: undefined;
            id?: undefined;
            since?: undefined;
            until?: undefined;
            project?: undefined;
            q?: undefined;
            cursor?: undefined;
            mode?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            since: {
                type: string;
                description: string;
            };
            until: {
                type: string;
                description: string;
            };
            project: {
                type: string;
                description: string;
            };
            q: {
                type: string;
                description: string;
            };
            cursor: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
            query?: undefined;
            tree?: undefined;
            id?: undefined;
            block?: undefined;
            start?: undefined;
            end?: undefined;
            mode?: undefined;
        };
        required?: undefined;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            mode: {
                type: string;
                enum: string[];
                description: string;
            };
            project: {
                type: string;
                description: string;
            };
            since: {
                type: string;
                description: string;
            };
            until: {
                type: string;
                description: string;
            };
            cursor: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
            tree?: undefined;
            id?: undefined;
            block?: undefined;
            start?: undefined;
            end?: undefined;
            q?: undefined;
        };
        required: string[];
    };
})[];
export interface MemtreeMcpDeps {
    /** The ccc loopback proxy, e.g. http://127.0.0.1:1234. */
    proxyUrl?: string;
    sessionId?: string;
    fetch?: typeof fetch;
    now?: () => number;
}
/** What the tree tools read: this session's current tree, or another one by id. */
export interface TreeSource {
    get(tree?: string): Promise<MemtreeIndex>;
    /** Term search, formatted; optional so a plain index can stand in (tests). */
    search?(query: string, limit: number | undefined, tree?: string): Promise<string>;
}
/**
 * Resolves, fetches and caches the current page, and other sessions' pages
 * by request id.
 */
export declare class CurrentTree implements TreeSource {
    private readonly deps;
    private cached?;
    /** Temporary prefix pages: when each may be fetched again. */
    private readonly prefixRetryAt;
    private inFlight?;
    /** Other trees, least recently used first. */
    private readonly others;
    /** Set once the server answered 404 to a tree search the page JSON could answer. */
    private serverSearchMissing;
    private readonly fetchImpl;
    private readonly now;
    constructor(deps: MemtreeMcpDeps);
    get(tree?: string): Promise<MemtreeIndex>;
    /**
     * The server's term search over the tree when it has the endpoint (no page
     * download), else the same search over the page JSON here.
     */
    search(query: string, limit: number | undefined, tree?: string): Promise<string>;
    private loadCurrent;
    private requireSessionId;
    /** The proxy's current page for the calling session; fails closed on any other session. */
    private currentId;
    private getOther;
    /**
     * Fetch one page. ``sessionId`` (the current tree only) must match the page's
     * session. A temporary prefix is returned but not cached by the callers, and
     * is refetched at most every PREFIX_RETRY_INTERVAL_MS, so successive tools
     * cannot hammer the page endpoint.
     */
    private loadPage;
    private prefixRetryError;
}
/** The cross-session tools: formatted text from the proxy's finder relay. */
export interface SessionFinderSource {
    listSessions(args: Record<string, unknown>): Promise<string>;
    searchSessions(args: Record<string, unknown>): Promise<string>;
}
export declare class SessionFinder implements SessionFinderSource {
    private readonly deps;
    private readonly fetchImpl;
    constructor(deps: MemtreeMcpDeps);
    listSessions(args: Record<string, unknown>): Promise<string>;
    searchSessions(args: Record<string, unknown>): Promise<string>;
    private get;
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
export declare function handleMcpMessage(message: JsonRpcRequest, tree: TreeSource, finder?: SessionFinderSource): Promise<object | undefined>;
/** Serve MCP over this process's stdin/stdout until stdin closes. */
export declare function runMemtreeMcpServer(env?: NodeJS.ProcessEnv): void;
export {};
//# sourceMappingURL=memtree-mcp.d.ts.map