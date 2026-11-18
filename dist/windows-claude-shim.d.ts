export declare class ClaudeLocationError extends Error {
}
declare function windowsFileExists(file: string): boolean;
/** A missing target (including an inner shim) lets discovery try the next PATH candidate. */
export declare function resolveWindowsClaude(command: string, readFile?: (f: string) => string, isFile?: typeof windowsFileExists): {
    file: string;
    node?: string;
} | undefined;
export {};
//# sourceMappingURL=windows-claude-shim.d.ts.map