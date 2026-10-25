export declare class ToolOutputStore {
    readonly dir: string;
    private readonly now;
    constructor(dir?: string, now?: () => number);
    /** Save `text` and return its path, or undefined when it could not be written. */
    save(text: string): string | undefined;
    /** The directory exists, is a real directory owned by this user, mode 700. */
    private privateDir;
    /** Drop the oldest files over EVICT_AFTER_MS old until both limits hold. */
    private evict;
}
//# sourceMappingURL=tool-output-store.d.ts.map