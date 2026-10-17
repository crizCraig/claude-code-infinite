/** The whole lookup, every page included, gives up after this long. */
export declare const LINK_TIMEOUT_MS = 5000;
export declare const LINK_EXIT: {
    readonly ok: 0;
    readonly error: 1;
    readonly usage: 2;
    readonly noTree: 3;
};
export declare const LINK_USAGE: string;
export interface LinkDeps {
    fetch: typeof fetch;
    baseUrl: string;
    /** The saved MemTree key for this environment, if any. */
    apiKey: string | undefined;
    /** `ccc` / `ccc staging` / `ccc local`, for the no-key hint. */
    command: string;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
    timeoutMs?: number;
}
export interface SessionLink {
    session_id: string;
    url: string;
    tree: string;
    /** The session's last activity (the listing has no tree time; the tree may trail it). */
    updated_at: string | null;
}
type Lookup = {
    kind: "found";
    link: SessionLink;
} | {
    kind: "none";
    reason: "no-session" | "no-tree";
} | {
    kind: "error";
    message: string;
};
/** Exit codes: LINK_EXIT. */
export declare function runLinkCommand(argv: readonly string[], deps: LinkDeps): Promise<number>;
/** `<session-id> [--json]`, in either order; anything else is a usage error. */
export declare function parseLinkArgs(argv: readonly string[]): {
    sessionId: string;
    json: boolean;
} | {
    error: string;
};
/** Pages through the owner's sessions matching the id, under one deadline. */
export declare function findSessionLink(sessionId: string, deps: Pick<LinkDeps, "fetch" | "baseUrl" | "apiKey" | "timeoutMs">): Promise<Lookup>;
export {};
//# sourceMappingURL=link-command.d.ts.map