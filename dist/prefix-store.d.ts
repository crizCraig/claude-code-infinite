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
    savedAt: number;
    prefix: PersistedPrefix;
    source?: PersistedSource;
}
export interface StablePrefixStoreLimits {
    /** Total bytes of all entries. */
    maxBytes: number;
    maxEntries: number;
}
declare const ENTRY_VERSION = 1;
export declare const STABLE_PREFIX_STORE_LIMITS: StablePrefixStoreLimits;
export declare class StablePrefixStore {
    readonly dir: string;
    private readonly limits;
    constructor(dir?: string, limits?: StablePrefixStoreLimits);
    /** The session's entry; a corrupt or foreign one is deleted (undefined). */
    load(sessionId: string): PersistedEntry | undefined;
    /** Replace the session's entry, then evict down to the limits. */
    save(sessionId: string, prefix: PersistedPrefix, source: PersistedSource | undefined, now?: number): void;
    delete(sessionId: string): void;
    /** Drop the oldest saves until the entry count and total size fit. */
    private evict;
    /** Entry files with their size and save time (file mtime). */
    private listEntries;
    private fileFor;
}
export {};
//# sourceMappingURL=prefix-store.d.ts.map