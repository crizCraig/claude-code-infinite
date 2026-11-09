export declare const SESSIONS_DEFAULT_LIMIT = 20;
export declare const SESSIONS_MAX_LIMIT = 100;
export declare const FINDER_SEARCH_DEFAULT_LIMIT = 10;
export declare const FINDER_SEARCH_MAX_LIMIT = 50;
export declare const FINDER_SEARCH_MODES: readonly ["vector", "text"];
export interface FinderProject {
    dir?: string | null;
    repo?: string | null;
    branch?: string | null;
    commit?: string | null;
}
export interface FinderTreeLinks {
    url?: string;
    html?: string;
    json?: string;
    lines?: string;
}
export interface FinderSession {
    id: string;
    kind?: string;
    session_id?: string | null;
    title?: string | null;
    snippet?: string | null;
    first_at?: string | null;
    last_at?: string | null;
    project?: FinderProject | null;
    models?: string[];
    request_count?: number;
    tokens?: {
        prompt?: number;
        completion?: number;
        conversation?: number | null;
    };
    /** `times`: when the tree's messages were written, first to last (servers from 2026-11). */
    latest_tree?: {
        request_id: string;
        ref?: string;
        links?: FinderTreeLinks;
        times?: unknown;
    } | null;
    /** How it ended, from the newest stored record (polychat memtree_session_endings.py). */
    ending?: FinderSessionEnding | null;
}
export interface FinderSessionEnding {
    at?: string | null;
    last_user?: string | null;
    actions?: string[];
    last_assistant?: string | null;
}
export interface FinderHit {
    id: string;
    kind?: string;
    session_id?: string | null;
    tree: {
        request_id: string;
        ref?: string;
        created_at?: string | null;
        links?: FinderTreeLinks | null;
    };
    leaf?: string;
    range?: {
        block: number;
        start: number;
        end: number;
    } | null;
    /** The lines joined; older servers send only this. */
    snippet?: string | null;
    /** The 1-3 lines densest in the query's words, by block line (servers from 2026-11-09). */
    snippets?: {
        line: number;
        text: string;
    }[] | null;
    /** The leaf's own summary (servers from 2026-11-09). */
    summary?: string | null;
    score?: number;
    embedding_model?: string;
    /** `<tree>#<node>`: the matched node, for read_node / read_lines `node`. */
    address?: string;
    node?: number;
    /** Ancestors of the node, root first. */
    path?: {
        id: number;
        summary: string;
    }[];
    /** When the hit's messages were written, `[earliest, latest]` UTC (servers with block times). */
    times?: unknown;
}
export interface FinderSessionsResponse {
    sessions?: FinderSession[];
    next_cursor?: string | null;
}
export interface FinderSearchResponse {
    query?: string;
    mode?: string;
    hits?: FinderHit[];
    groups?: FinderSearchGroup[];
    next_cursor?: string | null;
    matches_capped?: boolean;
    charged?: boolean;
    /** "any_word": no passage held every word, so these hold some of them. */
    relaxed?: string;
    /** On an empty first page across sessions (servers from 2026-11): what was searched. */
    coverage?: FinderSearchCoverage;
}
/** One embedding model's ranking. */
export interface FinderSearchGroup {
    embedding_model: string;
    hits: FinderHit[];
    has_more?: boolean;
    /** The ranking ran out of time, so only the newest trees were ranked (servers from 2026-11-09). */
    partial?: {
        trees?: number;
        of_trees?: number;
        since?: string | null;
        note?: string;
    } | null;
}
/** Counts and times of the caller's own sessions; never content (polychat memtree_search_coverage.py). */
export interface FinderSearchCoverage {
    sessions?: number;
    newest_indexed_at?: string | null;
    this_session?: {
        state?: string;
        indexed_at?: string | null;
        percent?: number;
        tokens?: number;
        start_tokens?: number;
    };
}
/** Query string for `/memtree/sessions` from the tool's arguments. */
export declare function sessionsQuery(args: Record<string, unknown>): string;
/** Query string for `/memtree/search`; `mode` defaults to text; `tree` scopes it to one tree. */
export declare function searchQuery(args: Record<string, unknown>, tree?: string): string;
/**
 * A search across all sessions that the server refused as too broad (422: it
 * did not finish in time) is retried over the newest days, widest window first.
 * Measured on staging (2026-11-06): ~28% of agent searches came back 422 after
 * 9-16 s. On its busiest account an unscoped search took ~10.5 s even for a word in
 * no session (the cost is finding the account's trees, not matching), 14 and 7 days
 * still timed out, and 2-3 days answered in ~0.5 s. The agents' own retries succeeded
 * once they added a recent `since`. Only when the caller set no tree, time bounds or
 * cursor.
 */
export declare const RECENT_SEARCH_WINDOWS_DAYS: readonly [3, 1];
/** The narrowed retry's arguments for `days`, or undefined when no retry applies. */
export declare function recentSearchArgs(args: Record<string, unknown>, tree: string | undefined, status: number, nowMs: number, days: number): Record<string, unknown> | undefined;
/** Added to the refusal when no narrowed window answered either. */
export declare function recentSearchFailedNote(triedDays: readonly number[], last: {
    status: number;
    error?: string;
}): string;
/** Said first in a narrowed retry's answer, so the model knows what was left out. */
export declare function recentSearchNote(since: string, days: number, pages?: boolean): string;
export declare function searchMode(value: unknown): (typeof FINDER_SEARCH_MODES)[number];
export declare function formatSessions(body: FinderSessionsResponse, args: Record<string, unknown>, 
/** The calling Claude Code session: its entry is marked "(this session)". */
currentSessionId?: string): string;
/** Said after a charged first page's heading (the server's `charged`). */
export declare const CHARGED_NOTE = "charged: one search";
export declare function formatSearchResults(body: FinderSearchResponse, args: Record<string, unknown>): string;
/** Ancestors root first, ` › `-joined, each with its address when the tree is known. */
export declare function formatPath(path: {
    id: number;
    summary: string;
}[], ref?: string): string;
/** What an empty search covered: sessions searched, the newest index, this session's state. */
export declare function coverageLines(coverage: FinderSearchCoverage | undefined): string[];
/**
 * Why a session may not be found, said on every empty search across sessions: only
 * ccc sessions are indexed, and a session's newest messages wait for its next index.
 */
export declare const NOT_SEARCHED_NOTE: string;
/** "how it ended" lines of a session: last user message, then the tools and last reply after it. */
export declare function endingLines(ending: FinderSessionEnding | null | undefined): string[];
//# sourceMappingURL=memtree-finder.d.ts.map