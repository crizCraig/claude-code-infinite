export declare class ToolOutputStore {
    readonly dir: string;
    constructor(dir?: string);
    /** Save `text` and return its path, or undefined when it could not be written. */
    save(text: string): string | undefined;
    /** The directory exists, is a real directory owned by this user, mode 700. */
    private privateDir;
    /** Drop the oldest files (never `keep`) until both limits hold. */
    private evict;
}
//# sourceMappingURL=tool-output-store.d.ts.map