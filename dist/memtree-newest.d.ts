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
 * Only the user-facing link uses this. The memory's source page stays what
 * `/memtree/current` (the MCP tools' `tree: "current"`) answers, since the
 * node ids in the memory message belong to that tree.
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
/** A lookup that has not answered by then is dropped; the next peek retries. */
export declare const NEWEST_TREE_FETCH_TIMEOUT_MS = 10000;
export interface NewestTree {
    /** The server-selected page, including its pinned namespace and source. */
    url: string;
    /** What makes the link news: the pinned tree ref. */
    key: string;
}
/** GET a polychat path with the user's key (MemtreeClient.fetchMemTree). */
export type NewestTreeFetch = (pathAndQuery: string, signal: AbortSignal) => Promise<{
    status: number;
    body: Buffer;
}>;
export declare class NewestTreeLookup {
    private readonly fetchPath;
    private readonly now;
    private readonly ttlMs;
    private readonly fetchTimeoutMs;
    private readonly entries;
    private readonly inFlight;
    private activeFetches;
    private unsupportedUntil;
    constructor(fetchPath: NewestTreeFetch, now?: () => number, ttlMs?: number, fetchTimeoutMs?: number);
    /** The cached answer, refreshing in the background when stale. Never waits. */
    peek(sessionId: string | undefined): NewestTree | undefined;
    /** A fresh answer if one arrives within `waitMs`, else the cached one. */
    settle(sessionId: string | undefined, waitMs?: number): Promise<NewestTree | undefined>;
    /**
     * Forget a session's answer and ask again: a newer compress page just
     * arrived, so a cached or in-flight answer may predate it.
     */
    invalidate(sessionId: string): void;
    private refresh;
    private fetch;
    /** All pages share one deadline; failures retain the last known answer. */
    private ask;
    private remember;
}
/**
 * The newest tree of exactly `sessionId` in a `/v1/memtree/sessions` body, or
 * undefined. `q` is a substring match over titles and snippets too, so only an
 * item whose `session_id` is this session counts: never another session's tree.
 */
export declare function newestTreeFrom(body: unknown, sessionId: string): NewestTree | undefined;
/** Preserve the server-selected reference; shortening it can select another tree. */
export declare function validatedTreeUrl(serverUrl: string): string | undefined;
//# sourceMappingURL=memtree-newest.d.ts.map