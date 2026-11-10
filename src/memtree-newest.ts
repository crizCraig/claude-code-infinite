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
export const NEWEST_TREE_TTL_MS = 60_000;
/** A server without the endpoint (404/405) is not asked again for this long. */
export const NEWEST_TREE_UNSUPPORTED_MS = 30 * 60_000;
/** Most a hook waits for an answer (Claude Code's hook relay gives up at 4 s). */
export const NEWEST_TREE_WAIT_MS = 2_500;
/** A lookup that has not answered by then is dropped; the next peek retries. */
export const NEWEST_TREE_FETCH_TIMEOUT_MS = 10_000;
/** Most `/memtree/current` waits: an MCP tool call can afford one whole lookup. */
export const NEWEST_TREE_CURRENT_WAIT_MS = NEWEST_TREE_FETCH_TIMEOUT_MS;
/** `q` also matches titles/snippets that quote the id; follow bounded pages. */
const SESSIONS_LIMIT = 10;
const MAX_SESSIONS = 200;
const MAX_PENDING = 8;
const MAX_PAGES = 32;
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface NewestTree {
  /** The server-selected page, including its pinned namespace and source. */
  url: string;
  /** What makes the link news: the pinned tree ref. */
  key: string;
}

/** GET a polychat path with the user's key (MemtreeClient.fetchMemTree). */
export type NewestTreeFetch = (
  pathAndQuery: string,
  signal: AbortSignal
) => Promise<{ status: number; body: Buffer }>;

/** `answered`: the server listed this session's tree or its absence (not a failure). */
export interface NewestTreeAnswer {
  tree?: NewestTree;
  answered: boolean;
}

interface Entry {
  tree?: NewestTree;
  fetchedAt: number;
  /**
   * The server said what this session's tree is, or that it has none. A failed
   * refresh keeps a known tree but not a known absence: the tree may exist now.
   */
  answered: boolean;
}

export class NewestTreeLookup {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, {
    promise: Promise<NewestTree | undefined>; dirty: boolean;
  }>();
  // Count the actual transports too: a fetch adapter ignoring abort must not
  // allow timed-out requests to accumulate behind new lookups.
  private activeFetches = 0;
  private unsupportedUntil = 0;

  constructor(
    private readonly fetchPath: NewestTreeFetch,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = NEWEST_TREE_TTL_MS,
    private readonly fetchTimeoutMs = NEWEST_TREE_FETCH_TIMEOUT_MS
  ) {}

  /** The cached answer, refreshing in the background when stale. Never waits. */
  peek(sessionId: string | undefined): NewestTree | undefined {
    if (!sessionId || !SESSION_ID.test(sessionId)) return undefined;
    const entry = this.entries.get(sessionId);
    if (!entry || this.now() - entry.fetchedAt >= this.ttlMs) void this.refresh(sessionId);
    return entry?.tree;
  }

  /** A fresh answer if one arrives within `waitMs`, else the cached one. */
  async settle(sessionId: string | undefined, waitMs = NEWEST_TREE_WAIT_MS): Promise<NewestTree | undefined> {
    const cached = this.peek(sessionId);
    const pending = sessionId ? this.inFlight.get(sessionId) : undefined;
    if (!pending) return cached;
    let timer: NodeJS.Timeout | undefined;
    const answer = await Promise.race([
      pending.promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return answer ? this.entries.get(sessionId!)?.tree : cached;
  }

  /**
   * `settle`, saying whether the server answered for this session, so "no
   * tree" is told apart from "could not ask" (`/memtree/current`). A server
   * without the sessions endpoint has no tree to offer: answered, none.
   */
  async current(sessionId: string, waitMs = NEWEST_TREE_CURRENT_WAIT_MS): Promise<NewestTreeAnswer> {
    await this.settle(sessionId, waitMs);
    // A newer page invalidated the lookup it waited on: wait for its replacement.
    if (!this.entries.has(sessionId) && this.inFlight.has(sessionId)) {
      await this.settle(sessionId, waitMs);
    }
    const entry = this.entries.get(sessionId);
    if (!entry && this.now() < this.unsupportedUntil) return { answered: true };
    return { tree: entry?.tree, answered: entry?.answered ?? false };
  }

  /**
   * Forget a session's answer and ask again: a newer compress page just
   * arrived, so a cached or in-flight answer may predate it.
   */
  invalidate(sessionId: string): void {
    this.entries.delete(sessionId);
    const running = this.inFlight.get(sessionId);
    if (running) running.dirty = true;
    else this.peek(sessionId);
  }

  private refresh(sessionId: string): Promise<NewestTree | undefined> {
    const running = this.inFlight.get(sessionId);
    if (running) return running.promise;
    if (this.now() < this.unsupportedUntil || this.inFlight.size >= MAX_PENDING ||
        this.activeFetches >= MAX_PENDING) return Promise.resolve(undefined);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    timer.unref();
    const flight = { promise: Promise.resolve<NewestTree | undefined>(undefined), dirty: false };
    flight.promise = this.ask(sessionId, controller.signal).then((entry) => {
      clearTimeout(timer);
      this.inFlight.delete(sessionId);
      // Coalesce all invalidations during this lookup into one replacement.
      if (flight.dirty) {
        this.peek(sessionId);
        return undefined;
      }
      if (entry) this.remember(sessionId, entry);
      return entry?.tree;
    });
    this.inFlight.set(sessionId, flight);
    return flight.promise;
  }

  private async fetch(path: string, signal: AbortSignal): Promise<{ status: number; body: Buffer }> {
    signal.throwIfAborted();
    if (this.activeFetches >= MAX_PENDING) throw new Error("Lookup capacity reached");
    this.activeFetches++;
    let onAbort: () => void = () => {};
    try {
      // Promise.resolve also turns synchronous adapter throws into rejections.
      const transport = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return this.fetchPath(path, signal);
      }).finally(() => { this.activeFetches--; });
      return await Promise.race([
        transport,
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** All pages share one deadline; failures retain the last known answer. */
  private async ask(sessionId: string, signal: AbortSignal): Promise<Entry | undefined> {
    const known = this.entries.get(sessionId);
    const entry = (): Entry => ({
      tree: known?.tree, fetchedAt: this.now(), answered: known?.tree !== undefined,
    });
    const answer = (tree?: NewestTree): Entry => ({ tree, fetchedAt: this.now(), answered: true });
    const query = new URLSearchParams({ q: sessionId, limit: String(SESSIONS_LIMIT) });
    const cursors = new Set<string>();
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await this.fetch(`/v1/memtree/sessions?${query}`, signal);
        if (res.status === 404 || res.status === 405) {
          this.unsupportedUntil = this.now() + NEWEST_TREE_UNSUPPORTED_MS;
          return undefined;
        }
        if (res.status !== 200) return entry();
        const body = JSON.parse(res.body.toString("utf-8"));
        if (!Array.isArray(body?.sessions)) return entry();
        const exact = body.sessions.find(
          (s: { session_id?: unknown } | null) => s?.session_id === sessionId
        ) as { latest_tree?: unknown } | undefined;
        if (exact) {
          // An unusable tree is not "none": keep what was known, like a failure.
          if (exact.latest_tree === null || exact.latest_tree === undefined) return answer();
          const tree = newestTreeFrom(body, sessionId);
          return tree ? answer(tree) : entry();
        }
        const cursor = body.next_cursor;
        if (cursor === null || cursor === undefined || cursor === "") return answer();
        if (typeof cursor !== "string" || cursors.has(cursor)) return entry();
        cursors.add(cursor);
        query.set("cursor", cursor);
      }
    } catch {
      // Offline, aborted, malformed JSON: notices still use the source page.
    }
    return entry();
  }

  private remember(sessionId: string, entry: Entry): void {
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
    while (this.entries.size > MAX_SESSIONS) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }
}

/**
 * The newest tree of exactly `sessionId` in a `/v1/memtree/sessions` body, or
 * undefined. `q` is a substring match over titles and snippets too, so only an
 * item whose `session_id` is this session counts: never another session's tree.
 */
export function newestTreeFrom(body: unknown, sessionId: string): NewestTree | undefined {
  const sessions = (body as { sessions?: unknown })?.sessions;
  if (!Array.isArray(sessions)) return undefined;
  const item = sessions.find(
    (s) => s && typeof s === "object" && (s as { session_id?: unknown }).session_id === sessionId
  ) as { latest_tree?: unknown } | undefined;
  const tree = item?.latest_tree as
    | { request_id?: unknown; ref?: unknown; links?: { url?: unknown } }
    | null
    | undefined;
  if (!tree || typeof tree.request_id !== "string" || typeof tree.links?.url !== "string") {
    return undefined;
  }
  const url = validatedTreeUrl(tree.links.url);
  if (!url) return undefined;
  const key = typeof tree.ref === "string" && tree.ref ? tree.ref : tree.request_id;
  return { url, key };
}

/** Preserve the server-selected reference; shortening it can select another tree. */
export function validatedTreeUrl(serverUrl: string): string | undefined {
  try {
    const parsed = new URL(serverUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}
