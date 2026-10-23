export declare class ToolOutputStore {
    readonly dir: string;
    constructor(dir?: string);
    /**
     * Save `text` and return its path, or undefined when it could not be written.
     * Eviction never removes a path in `keep` (the other copies one shortened
     * request points at).
     */
    save(text: string, keep?: ReadonlySet<string>): string | undefined;
    /** The directory exists, is a real directory owned by this user, mode 700. */
    private privateDir;
    /** Drop the oldest files (never one in `keep`) until both limits hold. */
    private evict;
}
//# sourceMappingURL=tool-output-store.d.ts.map