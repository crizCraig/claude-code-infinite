export declare class ClaudeLocationError extends Error {
}
declare function windowsFileExists(file: string): boolean;
declare function readSmallFile(file: string): string;
interface WindowsClaudeTarget {
    file: string;
    node?: string;
    env?: NodeJS.ProcessEnv;
}
/** A missing target (including an inner shim) lets discovery try the next PATH candidate. */
export declare function resolveWindowsClaude(command: string, readFile?: typeof readSmallFile, isFile?: typeof windowsFileExists, env?: NodeJS.ProcessEnv, home?: string): WindowsClaudeTarget | undefined;
export {};
//# sourceMappingURL=windows-claude-shim.d.ts.map