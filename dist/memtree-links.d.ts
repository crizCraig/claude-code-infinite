export interface StoredMemtreeLink {
    url: string;
    index: string;
    compressed: boolean;
    updatedAt: string;
}
export declare const MEMTREE_LINKS_MAX_SESSIONS = 200;
export declare class MemtreeLinkStore {
    readonly filePath: string;
    private readonly maxSessions;
    constructor(filePath?: string, maxSessions?: number);
    get(sessionId: string): StoredMemtreeLink | undefined;
    put(sessionId: string, link: Omit<StoredMemtreeLink, "updatedAt">): void;
    private readAll;
}
//# sourceMappingURL=memtree-links.d.ts.map