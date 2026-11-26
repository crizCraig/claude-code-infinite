/**
 * The newest completed MemTree for a Claude Code session, asked of the server.
 *
 * The proxy learns a page only from compress responses: the tree the session's
 * memory was built from. Once a session has compressed it can reuse that
 * byte-stable prefix for days while index-only calls keep building newer
 * trees, so the compress page goes stale as a link to show the user. The
 * server knows the newest one: `GET /v1/memtree/sessions` reports each
 * session's `latest_tree` (newest main-lane row whose tree completed), and
 * `q` matches session ids (polychat 0202eaa). Follow cursors because other
 * sessions can quote that id. The older exact-session pages endpoint excludes
 * index-only calls and does not identify completed trees, so cannot answer this.
 *
 * The user-facing link uses this. `/memtree/current` (the MCP tools' `tree:
 * "current"`) keeps answering the memory's source page, since the node ids in
 * the memory message belong to that tree, and falls back to this (`current`)
 * only when this process has no page for the session: after a restart, a
 * session whose history goes as index-only calls has a tree on the server but
 * no served index here.
 *
 * Never blocks a request: `peek` answers from the cache and refreshes in the
 * background; `settle` waits a bounded time, for hooks that can afford it.
 * Every failure reads as "unknown" and callers fall back to the source page.
 */
/** Seconds-scale freshness: trees complete every few turns, a link may lag one. */
export declare const NEWEST_TREE_TTL_MS = 60000;
/** A server without the endpoint (404/405) is not asked again for this long. */
export declare const NEWEST_TREE_UNSUPPORTED_MS: number;
/** Most a hook waits for an answer (Claude Code's hook relay gives up at 4 s). */
export declare const NEWEST_TREE_WAIT_MS = 2500;
/**
 * A lookup that has not answered by then is dropped; the next peek retries. Lookups run
 * in the background (callers wait at most their own bound), and the server's sessions
 * query took 7-22 s on staging (2026-11-12), so at 10 s most of them were dropped and
 * the link went stale.
 */
export declare const NEWEST_TREE_FETCH_TIMEOUT_MS = 30000;
/** Most `/memtree/current` waits: an MCP tool call can afford a typical lookup. */
export declare const NEWEST_TREE_CURRENT_WAIT_MS = 10000;
export declare const SESSION_ID: RegExp;
export interface NewestTree {
    /** The server-selected page, including its pinned namespace and source. */
    url: string;
    /** What makes the link news: the pinned tree ref. */
    key: string;
    /**
     * The session's stable link (`/m/sessions/<id>`), when the server names one: it sends
     * the owner to the session's newest page, so a link shown for long (the status line)
     * never goes stale. Older servers name none.
     */
    sessionUrl?: string;
}
/** GET a polychat path with the user's key (MemtreeClient.fetchMemTree). */
export type NewestTreeFetch = (pathAndQuery: string, signal: AbortSignal) => Promise<{
    status: number;
    body: Buffer;
}>;
/** `answered`: the server listed this session's tree or its absence (not a failure). */
export interface NewestTreeAnswer {
    tree?: NewestTree;
    answered: boolean;
}
export declare class NewestTreeLookup {
    private readonly fetchPath;
    private readonly now;
    private readonly ttlMs;
    private readonly fetchTimeoutMs;
    private readonly entries;
    private readonly inFlight;
    private activeFetches;
    private unsupportedUntil;
    private readonly listeners;
    /** Session → its stable link (`links.url`), tree or not; it never changes. Bounded. */
    private readonly sessionUrls;
    private readonly sessionLinkListeners;
    private readonly noTreeListeners;
    constructor(fetchPath: NewestTreeFetch, now?: () => number, ttlMs?: number, fetchTimeoutMs?: number);
    /** Call `listener` whenever a lookup answers with a session's tree (the status line). */
    onTree(listener: (sessionId: string, tree: NewestTree) => void): void;
    /** Call `listener` when a lookup first names a session's stable link (the status line). */
    onSessionLink(listener: (sessionId: string, url: string) => void): void;
    /** The session's stable link, once any lookup named it (even before its first tree). */
    sessionUrl(sessionId: string | undefined): string | undefined;
    /** Call `listener` when the server answers that a session has no tree yet. */
    onNoTree(listener: (sessionId: string) => void): void;
    private notifyAnswered;
    /** Whether the server has answered for this session (a tree or its absence). */
    answered(sessionId: string): boolean;
    /** The cached answer, refreshing in the background when stale. Never waits. */
    peek(sessionId: string | undefined): NewestTree | undefined;
    /** A fresh answer if one arrives within `waitMs`, else the cached one. */
    settle(sessionId: string | undefined, waitMs?: number): Promise<NewestTree | undefined>;
    /**
     * `settle`, saying whether the server answered for this session, so "no
     * tree" is told apart from "could not ask" (`/memtree/current`). Only a
     * fresh answer says "none": an expired one that could not be refreshed
     * (capacity, a server without the endpoint) is unknown, while a known tree
     * is kept. Waits at most twice `waitMs` (once more after an invalidation).
     */
    current(sessionId: string, waitMs?: number): Promise<NewestTreeAnswer>;
    /**
     * Forget a session's answer: a newer compress page just arrived, so a cached
     * or in-flight answer may predate it. With `refresh` (default true), starts a
     * replacement lookup in the background; with `refresh = false`, drops stale
     * state without issuing a server request until a caller asks.
     */
    invalidate(sessionId: string, refresh?: boolean): void;
    private refresh;
    private fetch;
    /** All pages share one deadline; failures retain the last known answer. */
    private ask;
    private rememberSessionUrl;
    private remember;
}
/**
 * The newest tree of exactly `sessionId` in a `/v1/memtree/sessions` body, or
 * undefined. `q` is a substring match over titles and snippets too, so only an
 * item whose `session_id` is this session counts: never another session's tree.
 */
export declare function newestTreeFrom(body: unknown, sessionId: string): NewestTree | undefined;
/** A sessions item's stable link (`links.url`, polychat's /m/sessions/<id>), validated. */
export declare function sessionUrlFrom(item: unknown): string | undefined;
/** Preserve the server-selected reference; shortening it can select another tree. */
export declare function validatedTreeUrl(serverUrl: string): string | undefined;
//# sourceMappingURL=memtree-newest.d.ts.map