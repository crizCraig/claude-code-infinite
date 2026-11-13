export declare const STATUS_LINK_DIR = "statusline";
export declare const STATUS_LINK_SUFFIX = ".url";
export declare function statusLinkDir(): string;
/** The cached link for `sessionId`, or undefined. Never throws. */
export declare function readStatusLink(sessionId: unknown, dir?: string): string | undefined;
export declare class StatusLinkFiles {
    readonly dir: string;
    private readonly maxFiles;
    private readonly written;
    private writes;
    constructor(dir?: string, maxFiles?: number);
    /** Record `url` as the session's link; writes only when it changed. Never throws. */
    write(sessionId: string | undefined, url: string | undefined): void;
    private remember;
    /** Keep the newest maxFiles links (by modification time). */
    private prune;
}
//# sourceMappingURL=status-link.d.ts.map