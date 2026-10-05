/**
 * The newest completed MemTree for a Claude Code session, asked of the server.
 *
 * The proxy learns a page only from compress responses: the tree the session's
 * memory was built from. Once a session has compressed it can reuse that
 * byte-stable prefix for days while index-only calls keep building newer
 * trees, so the compress page goes stale as a link to show the user. The
 * server knows the newest one: `GET /v1/memtree/sessions` reports each
 * session's `latest_tree` (newest main-lane row whose tree completed), and
 * `q` matches session ids (polychat 0202eaa).
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
export const NEWEST_TREE_TTL_MS = 60_000;
/** A server without the endpoint (404/405) is not asked again for this long. */
export const NEWEST_TREE_UNSUPPORTED_MS = 30 * 60_000;
/** Most a hook waits for an answer (Claude Code's hook relay gives up at 4 s). */
export const NEWEST_TREE_WAIT_MS = 2_500;
/** A lookup that has not answered by then is dropped; the next peek retries. */
export const NEWEST_TREE_FETCH_TIMEOUT_MS = 10_000;
/** `q` also matches titles/snippets that quote the id; a page of them suffices. */
const SESSIONS_LIMIT = 10;
const MAX_SESSIONS = 200;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHORT_ID_HEX = 12;

export interface NewestTree {
  /** The page link to show: `/m/<short id>` on the server's origin. */
  url: string;
  /** What makes the link news: the pinned tree ref. */
  key: string;
}

/** GET a polychat path with the user's key (MemtreeClient.fetchMemTree). */
export type NewestTreeFetch = (
  pathAndQuery: string
) => Promise<{ status: number; body: Buffer }>;

interface Entry {
  tree?: NewestTree;
  fetchedAt: number;
}

export class NewestTreeLookup {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<NewestTree | undefined>>();
  private unsupportedUntil = 0;

  constructor(
    private readonly fetchPath: NewestTreeFetch,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = NEWEST_TREE_TTL_MS
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
      pending.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return answer ? this.entries.get(sessionId!)?.tree : cached;
  }

  /**
   * Forget a session's answer and ask again: a newer compress page just
   * arrived, so a cached or in-flight answer may predate it.
   */
  invalidate(sessionId: string): void {
    this.entries.delete(sessionId);
    this.inFlight.delete(sessionId);
    this.peek(sessionId);
  }

  private refresh(sessionId: string): Promise<NewestTree | undefined> {
    const running = this.inFlight.get(sessionId);
    if (running) return running;
    if (this.now() < this.unsupportedUntil) return Promise.resolve(undefined);
    const pending: Promise<NewestTree | undefined> = this.ask(sessionId).then((entry) => {
      // An answer overtaken by invalidate() is not stored.
      if (this.inFlight.get(sessionId) !== pending) return entry?.tree;
      this.inFlight.delete(sessionId);
      if (entry) this.remember(sessionId, entry);
      return entry?.tree;
    });
    this.inFlight.set(sessionId, pending);
    return pending;
  }

  /** The server's answer, or undefined when it has no such endpoint. */
  private async ask(sessionId: string): Promise<Entry | undefined> {
    const query = new URLSearchParams({ q: sessionId, limit: String(SESSIONS_LIMIT) });
    const previous = this.entries.get(sessionId)?.tree;
    let tree: NewestTree | undefined;
    try {
      const res = await this.fetchPath(`/v1/memtree/sessions?${query}`);
      if (res.status === 404 || res.status === 405) {
        this.unsupportedUntil = this.now() + NEWEST_TREE_UNSUPPORTED_MS;
        return undefined;
      }
      // Any other failure keeps the last answer and waits out the TTL.
      tree = res.status === 200
        ? newestTreeFrom(JSON.parse(res.body.toString("utf-8")), sessionId)
        : previous;
    } catch {
      tree = previous;
    }
    return { tree, fetchedAt: this.now() };
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
  const url = shortTreeUrl(tree.links.url, tree.request_id);
  if (!url) return undefined;
  const key = typeof tree.ref === "string" && tree.ref ? tree.ref : tree.request_id;
  return { url, key };
}

/**
 * `<origin>/m/<leading 12 hex>`: the spelling compress responses stamp, short
 * enough for a terminal line and the same page as the pinned ref link. Falls
 * back to the server's link when the request id is not a UUID.
 */
export function shortTreeUrl(serverUrl: string, requestId: string): string | undefined {
  let origin: string;
  try {
    const parsed = new URL(serverUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    origin = parsed.origin;
  } catch {
    return undefined;
  }
  const hex = requestId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return serverUrl;
  return `${origin}/m/${hex.slice(0, SHORT_ID_HEX)}`;
}
