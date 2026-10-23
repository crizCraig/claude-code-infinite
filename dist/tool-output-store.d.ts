export declare class ToolOutputStore {
    readonly dir: string;
    private readonly now;
    constructor(dir?: string, now?: () => number);
    /** Save `text` and return its path, or undefined when it could not be written. */
    save(text: string): string | undefined;
    /** The directory exists, is a real directory owned by this user, mode 700. */
    private privateDir;
    /** Drop the oldest files not touched within PIN_MS until both limits hold. */
    private evict;
    /**
     * Remove `file` unless it was touched since `recent`: renamed aside first,
     * so a reuse that touched it before the rename is seen there (and the file
     * put back) and one after it finds the file gone and writes it again.
     */
    private evictOne;
}
//# sourceMappingURL=tool-output-store.d.ts.map