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
/**
 * Says once per session, after a tool's answer, that ccc was updated on disk since
 * this server started: Claude Code keeps an MCP server for the whole session, so
 * the tools stay the version it loaded (an older one may lack message times) until
 * ccc restarts. Silent when the versions match or package.json is unreadable.
 */
export declare class StaleToolsNotice {
    private readonly readInstalled;
    private readonly own;
    private readonly now;
    private readonly startedAt;
    private said;
    private checkedAt;
    constructor(readInstalled?: () => string | undefined, own?: string, now?: () => number, startedAt?: Date);
    next(): string | undefined;
}
export declare function staleToolsNote(installed: string, own: string, startedAt: Date): string;
/** The version in this install's package.json now (ccc may have been updated since it started). */
export declare function installedVersion(): string | undefined;
/** Sent to MemTree as `x-memtree-tools` when this server is configured. */
export declare const MEMTREE_TOOL_NAMES: readonly ["search", "read_node", "read_lines", "list", "user_messages", "handover"];
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
            context?: undefined;
            days?: undefined;
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
            context?: undefined;
            days?: undefined;
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
            context?: undefined;
            days?: undefined;
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
            context?: undefined;
            days?: undefined;
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
            tree: {
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
            query: {
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
            full: {
                type: string;
                description: string;
            };
            context: {
                type: string;
                description: string;
            };
            mode?: undefined;
            project?: undefined;
            node?: undefined;
            id?: undefined;
            block?: undefined;
            start?: undefined;
            end?: undefined;
            tail?: undefined;
            q?: undefined;
            days?: undefined;
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
            tree: {
                type: string;
                description: string;
            };
            days: {
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
            query?: undefined;
            mode?: undefined;
            project?: undefined;
            cursor?: undefined;
            limit?: undefined;
            node?: undefined;
            id?: undefined;
            block?: undefined;
            start?: undefined;
            end?: undefined;
            tail?: undefined;
            full?: undefined;
            q?: undefined;
            context?: undefined;
        };
        required?: undefined;
    };
})[];
export interface MemtreeMcpDeps {
    /** The ccc loopback proxy, e.g. http://127.0.0.1:1234. */
    proxyUrl?: string;
    sessionId?: string;
    /** HOST_TOKEN_ENV: set by a ccc whose proxy answers `/memtree/host-session`. */
    hostToken?: string;
    /** The ccc desktop service's proxy token, sent as x-ccc-proxy-token on every call. */
    token?: string;
    fetch?: typeof fetch;
    now?: () => number;
}
/**
 * Sent with each tool's proxy reads: which tool (`page` is a whole tree's `.json`) and
 * the calling session, which the proxy passes on so the server's one content-free log
 * line per call can say which tool read what (polychat memtree_tool_log.py). Not to be
 * confused with `x-memtree-tools`, the list of configured tools sent on compress calls.
 */
export declare const MEMTREE_TOOL_HEADER = "x-memtree-tool";
/** The desktop service's loopback routes require its proxy token. */
export declare const PROXY_TOKEN_HEADER = "x-ccc-proxy-token";
/**
 * A ccc proxy named by Claude Code's own HTTPS_PROXY
 * (`http://ccc:<token>@127.0.0.1:<port>`, the desktop service or a proxy-mode ccc).
 */
export declare function cccProxyFromEnv(env: NodeJS.ProcessEnv): {
    url: string;
    token: string;
} | undefined;
/**
 * Where the server registered in ~/.claude.json for the
 * Claude desktop app (CCC_MEMTREE_MCP_DESKTOP=1) reads from. The same entry is
 * seen by every Claude Code on this account, so outside a ccc-routed session
 * it is inert: no tools, no instructions.
 */
export declare function desktopMcpTarget(env: NodeJS.ProcessEnv): {
    proxyUrl: string;
    token?: string;
} | undefined;
export declare function toolHeaders(tool: string, deps: MemtreeMcpDeps): Record<string, string>;
/**
 * Point `deps.sessionId` at the session this server's Claude Code process is on now.
 * Claude Code starts the server with the session id it had at launch and does not
 * restart it when the process moves to another session (a resume through the picker,
 * /resume, /clear), so that id can name a session with no page ("no MemTree yet",
 * 2026-11-09). The proxy of the ccc that launched this Claude Code knows the process's
 * session from its SessionStart hook and answers only that process (`hostPid`: this
 * server's parent, with the token from ccc's MCP config). Without a token (an older
 * ccc's config: its proxy has no such route) nothing is asked; any other answer
 * (another process, no session start seen) leaves the id as it is.
 */
export declare function refreshHostSession(deps: MemtreeMcpDeps, hostPid?: number): Promise<void>;
/**
 * The desktop service can't name a process's session the way terminal ccc's proxy does
 * (refreshHostSession), so read Claude Code's own record of its process (`<config
 * dir>/sessions/<pid>.json`, which follows /clear and /resume; Claude Code 2.1.3xx).
 * Best effort: anything unreadable keeps the current id (review r1 P2).
 */
export declare function refreshSessionFromClaudePidFile(deps: MemtreeMcpDeps, env: NodeJS.ProcessEnv, hostPid?: number): void;
/** What the tree tools read: this session's current tree, or another one by id. */
export interface TreeSource {
    get(tree?: string): Promise<MemtreeIndex>;
    /** This session's current tree id (for searches scoped to it on the server). */
    currentId?(validatePage?: boolean): Promise<string>;
    /** Term search, formatted; optional so a plain index can stand in (tests). */
    search?(query: string, limit: number | undefined, tree?: string): Promise<string>;
    /** The un-indexed messages after the tree, read fresh from the server; `full`: tool calls whole. */
    tail?(tree: string | undefined, start?: number, end?: number, full?: boolean): Promise<string>;
    /** A tree's `user_messages` or `handover` answer (JSON), read fresh from the server. */
    serverRead?(route: TreeRoute, tree: string | undefined, params: URLSearchParams): Promise<unknown>;
}
/** Per-tree server reads that are not page JSON: the person's messages, the handover pack. */
export type TreeRoute = "user_messages" | "handover";
/**
 * Resolves, fetches and caches the current page, and other sessions' pages
 * by request id.
 */
export declare class CurrentTree implements TreeSource {
    private readonly deps;
    private cached?;
    /** The session `cached` was read for: a page is never reused across sessions. */
    private cachedSession?;
    /** Temporary prefix pages: when each may be fetched again. */
    private readonly prefixRetryAt;
    /** The last fetched temporary prefix per page, served during its cooldown. */
    private readonly prefixes;
    private inFlight?;
    /** Other trees, least recently used first. */
    private readonly others;
    /** Pages whose per-message times were incomplete: when to refetch them (timesDue). */
    private readonly timesRetryAt;
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
    /**
     * `/memtree/<id>/<route>`, never cached (the newest messages grow). This session's
     * tree must be this session's (as tail); a 404 without the server's own detail means
     * the server or this ccc's proxy predates the route.
     */
    serverRead(route: TreeRoute, tree: string | undefined, params: URLSearchParams): Promise<unknown>;
    private loadCurrent;
    /**
     * Whether a cached page's per-message times were incomplete (`line_times_incomplete`:
     * the server's times lookup was slow) and are due a refetch. The page itself is
     * readable meanwhile, so it stays cached; only its times are retried.
     */
    private timesDue;
    /** `load()`, or the readable `stale` copy when that fails (its times retried later). */
    private refreshed;
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
    /** The newest tree of the user's session `sessionId`, or undefined (none, or not a session). */
    sessionTree?(sessionId: string): Promise<string | undefined>;
    /** Server search across sessions, or within ``tree`` (any mode). */
    searchSessions(args: Record<string, unknown>, tree?: string): Promise<string>;
}
export declare class SessionFinder implements SessionFinderSource {
    private readonly deps;
    private readonly fetchImpl;
    constructor(deps: MemtreeMcpDeps);
    listSessions(args: Record<string, unknown>): Promise<string>;
    private readonly sessionTrees;
    /** sessionTree, remembered for SESSION_TREE_TTL_MS (hits and misses: legacy ids repeat). */
    sessionTree(sessionId: string): Promise<string | undefined>;
    private lookupSessionTree;
    searchSessions(args: Record<string, unknown>, tree?: string): Promise<string>;
    private now;
    private get;
    private fetch;
    private bodyOf;
}
/**
 * One JSON-RPC message in, the response out (undefined for notifications).
 * Exposed for tests; the stdio loop below is only framing.
 */
export declare function handleMcpMessage(input: unknown, tree: TreeSource, finder?: SessionFinderSource, 
/** versionMismatchNote: appended to failed tool calls. */
versionNote?: string, 
/** A note to append once, to whichever tool answer comes first (StaleToolsNotice). */
notice?: {
    next(): string | undefined;
}, 
/** Not in a ccc-routed session: no tools, no instructions. */
inert?: boolean): Promise<object | undefined>;
/** Serve MCP over this process's stdin/stdout until stdin closes. */
export declare function runMemtreeMcpServer(env?: NodeJS.ProcessEnv): void;
//# sourceMappingURL=memtree-mcp.d.ts.map