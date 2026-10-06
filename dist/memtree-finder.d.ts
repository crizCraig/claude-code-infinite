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
    latest_tree?: {
        request_id: string;
        ref?: string;
        links?: FinderTreeLinks;
    } | null;
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
    snippet?: string | null;
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
}
export interface FinderSessionsResponse {
    sessions?: FinderSession[];
    next_cursor?: string | null;
}
export interface FinderSearchResponse {
    query?: string;
    mode?: string;
    hits?: FinderHit[];
    groups?: {
        embedding_model: string;
        hits: FinderHit[];
        has_more?: boolean;
    }[];
    next_cursor?: string | null;
    matches_capped?: boolean;
    charged?: boolean;
    /** "any_word": no passage held every word, so these hold some of them. */
    relaxed?: string;
}
/** Query string for `/memtree/sessions` from the tool's arguments. */
export declare function sessionsQuery(args: Record<string, unknown>): string;
/** Query string for `/memtree/search`; `mode` defaults to text; `tree` scopes it to one tree. */
export declare function searchQuery(args: Record<string, unknown>, tree?: string): string;
export declare function searchMode(value: unknown): (typeof FINDER_SEARCH_MODES)[number];
export declare function formatSessions(body: FinderSessionsResponse, args: Record<string, unknown>): string;
export declare function formatSearchResults(body: FinderSearchResponse, args: Record<string, unknown>): string;
/** Ancestors root first, ` › `-joined, each with its address when the tree is known. */
export declare function formatPath(path: {
    id: number;
    summary: string;
}[], ref?: string): string;
//# sourceMappingURL=memtree-finder.d.ts.map