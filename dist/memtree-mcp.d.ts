import { MemtreeIndex } from "./memtree-tools.js";
export declare const MEMTREE_MCP_SERVER_NAME = "memtree";
/**
 * The version of the ccc whose proxy this server talks to, set in the config
 * ccc writes (memtree-mcp-config.ts). Claude Code may (re)start this server
 * mid-session, after an update replaced ccc's files: the server then runs the
 * new code against the old proxy. The proxy's /memtree endpoints only grow, and
 * this server already tolerates a missing one (404), so it keeps working; a
 * failing tool call says why, so the fix (restart ccc) is clear.
 */
export declare const PROXY_VERSION_ENV = "CCC_PROXY_VERSION";
/** The note added to failed tool calls when this server and its proxy differ. */
export declare function versionMismatchNote(proxyVersion: string | undefined, ownVersion?: string): string | undefined;
/** Sent to MemTree as `x-memtree-tools` when this server is configured. */
export declare const MEMTREE_TOOL_NAMES: readonly ["search", "read_node", "read_lines", "list"];
/** `tree` value naming this session's own current tree. */
export declare const CURRENT_TREE = "current";
/**
 * The MCP server's instructions, which Claude Code places in the system prompt
 * from the first request: the one place that explains the agent's situation
 * before any memory message exists. Constant, so the prompt cache holds.
 */
export declare const MEMTREE_MCP_INSTRUCTIONS: string;
/**
 * Claude Code's per-tool key (2.1.296): the tool is in the prompt from the
 * first turn, not deferred behind tool search. ccc's own --mcp-config also sets
 * the server's `alwaysLoad`; this covers caller-supplied configs too (the
 * recall probe, `ccc memtree-mcp`).
 */
export declare const MEMTREE_TOOL_META: {
    readonly "anthropic/alwaysLoad": true;
};
/**
 * Said in `search`'s description, the one text a resumed session gets fresh:
 * Claude Code keeps a session's MCP instructions and deferred-tools list as
 * first announced, and never takes a name off that list once the tool is
 * loaded, so a session begun before alwaysLoad still lists these as deferred.
 */
export declare const MEMTREE_LOADED_NOTE: string;
export declare const MEMTREE_TOOLS: ({
    _meta: {
        readonly "anthropic/alwaysLoad": true;
    };
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            tree: {
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
            node?: undefined;
            id?: undefined;
            block?: undefined;
            start?: undefined;
            end?: undefined;
            tail?: undefined;
            full?: undefined;
            q?: undefined;
        };
        required: string[];
    };
} | {
    _meta: {
        readonly "anthropic/alwaysLoad": true;
    };
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            node: {
                type: string;
                description: string;
            };
            id: {
                type: string;
                description: string;
            };
            tree: {
                type: string;
                description: string;
            };
            query?: undefined;
            mode?: undefined;
            project?: undefined;
            since?: undefined;
            until?: undefined;
            cursor?: undefined;
            limit?: undefined;
            block?: undefined;
            start?: undefined;
            end?: undefined;
            tail?: undefined;
            full?: undefined;
            q?: undefined;
        };
        required?: undefined;
    };
} | {
    _meta: {
        readonly "anthropic/alwaysLoad": true;
    };
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            node: {
                type: string;
                description: string;
            };
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
            tail: {
                type: string;
                description: string;
            };
            full: {
                type: string;
                description: string;
            };
            query?: undefined;
            mode?: undefined;
            project?: undefined;
            since?: undefined;
            until?: undefined;
            cursor?: undefined;
            limit?: undefined;
            id?: undefined;
            q?: undefined;
        };
        required?: undefined;
    };
} | {
    _meta: {
        readonly "anthropic/alwaysLoad": true;
    };
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
            mode?: undefined;
            node?: undefined;
            id?: undefined;
            block?: undefined;
            start?: undefined;
            end?: undefined;
            tail?: undefined;
            full?: undefined;
        };
        required?: undefined;
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
    /** This session's current tree id (for searches scoped to it on the server). */
    currentId?(validatePage?: boolean): Promise<string>;
    /** Term search, formatted; optional so a plain index can stand in (tests). */
    search?(query: string, limit: number | undefined, tree?: string): Promise<string>;
    /** The un-indexed messages after the tree, read fresh from the server; `full`: tool calls whole. */
    tail?(tree: string | undefined, start?: number, end?: number, full?: boolean): Promise<string>;
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
    /** The last fetched temporary prefix per page, served during its cooldown. */
    private readonly prefixes;
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
    /**
     * The server's un-indexed tail after the tree (`/messages`), never cached:
     * it grows with the conversation. With no range, the newest messages.
     */
    tail(tree: string | undefined, start?: number, end?: number, full?: boolean): Promise<string>;
    private loadCurrent;
    private requireSessionId;
    /** The proxy's current page for the calling session; fails closed on any other session. */
    currentId(validatePage?: boolean): Promise<string>;
    private checkSession;
    private getOther;
    /**
     * Fetch one page. ``sessionId`` (the current tree only) must match the page's
     * session. A temporary prefix (the newest completed tree for an earlier part
     * of the conversation, shown until the request's own tree is built) is not
     * cached for good: it is refetched at most every PREFIX_RETRY_INTERVAL_MS, and
     * the last copy is served in between, so successive tools neither hammer the
     * page endpoint nor get an error for a tree they could read.
     */
    private loadPage;
    private prefixRetryError;
}
/** The cross-session tools: formatted text from the proxy's finder relay. */
export interface SessionFinderSource {
    listSessions(args: Record<string, unknown>): Promise<string>;
    /** Server search across sessions, or within ``tree`` (any mode). */
    searchSessions(args: Record<string, unknown>, tree?: string): Promise<string>;
}
export declare class SessionFinder implements SessionFinderSource {
    private readonly deps;
    private readonly fetchImpl;
    constructor(deps: MemtreeMcpDeps);
    listSessions(args: Record<string, unknown>): Promise<string>;
    searchSessions(args: Record<string, unknown>, tree?: string): Promise<string>;
    private get;
}
/**
 * One JSON-RPC message in, the response out (undefined for notifications).
 * Exposed for tests; the stdio loop below is only framing.
 */
export declare function handleMcpMessage(input: unknown, tree: TreeSource, finder?: SessionFinderSource, 
/** versionMismatchNote: appended to failed tool calls. */
versionNote?: string): Promise<object | undefined>;
/** Serve MCP over this process's stdin/stdout until stdin closes. */
export declare function runMemtreeMcpServer(env?: NodeJS.ProcessEnv): void;
//# sourceMappingURL=memtree-mcp.d.ts.map