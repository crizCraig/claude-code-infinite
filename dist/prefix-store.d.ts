/** The stored fields of a stable prefix (proxy.ts StablePrefix, minus sizes). */
export interface PersistedPrefix {
    originalSystemHash: string;
    originalPrefixHashes: string[];
    compressedMessages: any[];
    compressedSystem: unknown;
    hasCompressedSystem: boolean;
    targetTokens: number;
    explicitTarget: boolean;
    modelContextLimit: number;
}
/** The MemTree page the prefix's memory came from (memory-source pointer). */
export interface PersistedSource {
    url: string;
    index: string;
    compressed: boolean;
}
export interface PersistedEntry {
    version: typeof ENTRY_VERSION;
    sessionId: string;
    /** MemtreeClient.storageIdentity of the backend and account that wrote it. */
    owner: string;
    savedAt: number;
    prefix: PersistedPrefix;
    source?: PersistedSource;
}
export interface StablePrefixStoreLimits {
    /** Total bytes of all entries (and recent temporary files). */
    maxBytes: number;
    maxEntries: number;
}
declare const ENTRY_VERSION = 2;
export declare const STABLE_PREFIX_STORE_LIMITS: StablePrefixStoreLimits;
export declare class StablePrefixStore {
    readonly dir: string;
    private readonly limits;
    constructor(dir?: string, limits?: StablePrefixStoreLimits);
    /** The session's entry for `owner`; an unreadable or invalid one is deleted. */
    load(sessionId: string, owner: string): PersistedEntry | undefined;
    /** Replace the session's entry, then evict down to the limits. */
    save(sessionId: string, owner: string, prefix: PersistedPrefix, source: PersistedSource | undefined, now?: number): void;
    delete(sessionId: string, owner: string): void;
    /** Where the entry for this session and owner lives. */
    entryPath(sessionId: string, owner: string): string;
    /**
     * The directory exists (created when `create`), is a real directory (not a
     * symlink) owned by this user, and is mode 700 (repaired when it is not).
     */
    private privateDir;
    /** Drop stale temporaries, then the oldest saves until the limits fit. */
    private evict;
    /**
     * Entry files with size and save time. Symlinks and stale temporaries are
     * removed; recent temporaries (writes in progress) count toward the size.
     */
    private scan;
}
export {};
//# sourceMappingURL=prefix-store.d.ts.map