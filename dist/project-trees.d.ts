/**
 * Earlier MemTree sessions in this project, named to the model when a session
 * starts, so earlier decisions and fixes are one lookup away.
 *
 * The server answers `GET /v1/memtree/project_trees?project=&limit=` (polychat
 * routes/memtree_project_trees.py): the user's own newest sessions in this
 * project that have a finished tree, each with its root summary and tree
 * reference. ccc asks once at startup (before Claude Code is up) and again in
 * the background at each later session start, so a SessionStart hook only
 * waits briefly for an answer already on its way.
 *
 * The block goes into the SessionStart hook's `additionalContext`: the model
 * reads it, the user sees it only in the transcript view. It is added only when
 * the session has the `memtree` MCP tools it names, never for a subagent or a
 * compaction, and not at all on any failure: an older server (404), a slow or
 * failed request, no project, or no earlier trees.
 */
/** Trees named at most. */
export declare const PROJECT_TREES_LIMIT = 5;
/** Most a SessionStart hook waits for an answer still on its way. */
export declare const PROJECT_TREES_WAIT_MS = 300;
/** A request that has not answered by then is dropped. */
export declare const PROJECT_TREES_FETCH_TIMEOUT_MS = 5000;
/** A later session start reuses an answer this fresh instead of asking again. */
export declare const PROJECT_TREES_FRESH_MS = 60000;
/** Root summaries are cut to this many characters. */
export declare const PROJECT_TREES_SUMMARY_CHARS = 150;
export declare const PROJECT_TREES_HEADER: string;
export declare const PROJECT_TREES_FOOTER: string;
export interface ProjectTree {
    session_id?: string | null;
    last_at?: string | null;
    title: string;
    ref: string;
}
/** GET a polychat path with the user's key (MemtreeClient.fetchMemTree). */
export type ProjectTreesFetch = (pathAndQuery: string, signal: AbortSignal) => Promise<{
    status: number;
    body: Buffer;
}>;
export declare class ProjectTreesHint {
    private readonly fetchJson;
    private readonly project;
    private readonly waitMs;
    private readonly now;
    private pending;
    private latest;
    private disabled;
    private fetchedAt;
    /** The server answered 404/405: it has no such endpoint; not asked again this run. */
    private unsupported;
    constructor(fetchJson: ProjectTreesFetch, project: string, waitMs?: number, now?: () => number);
    /** No more blocks: the session lost the tools they name (memtree MCP config failed). */
    disable(): void;
    /** Start a lookup unless one is on its way; never throws. */
    prefetch(): void;
    /**
     * The block for a session starting now, or undefined. Waits at most
     * `waitMs` for a lookup on its way, then refreshes in the background for
     * the next session start (an in-app `/clear` or `/resume`).
     */
    contextFor(sessionId: string | undefined): Promise<string | undefined>;
    private lookup;
}
/**
 * The project name the server matches: the `owner/repo` of the `origin`
 * remote. A directory name alone ("app", "src") would also match unrelated
 * directories and repos of that name, so without a remote there is no hint.
 */
export declare function projectIdentity(meta: {
    git_repo?: string;
} | undefined): string | undefined;
/** The server's `trees`, keeping only well-formed entries. */
export declare function parseProjectTrees(body: unknown): ProjectTree[] | undefined;
/** The context block, or undefined when no tree but the current session's is left. */
export declare function formatProjectTrees(trees: readonly ProjectTree[], currentSessionId: string | undefined): string | undefined;
/**
 * The hint for this run, or undefined: interactive sessions only (print runs
 * keep Claude Code's output as it is), with both `search` and `read_node`
 * (the block names them), a known project, and not `CCC_PROJECT_TREES=0`.
 */
export declare function projectTreesHintFor(interactive: boolean, tools: readonly string[], meta: {
    git_repo?: string;
} | undefined, env: NodeJS.ProcessEnv, fetchJson: ProjectTreesFetch): ProjectTreesHint | undefined;
//# sourceMappingURL=project-trees.d.ts.map