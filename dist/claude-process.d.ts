import { type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
export declare function claudeInvocation(command: string, args: string[], platform?: NodeJS.Platform, readManifest?: (file: string) => string): {
    command: string;
    args: string[];
};
export declare function spawnClaude(command: string, args: string[], options: SpawnOptions): import("node:child_process").ChildProcess;
export declare function spawnClaudeSync(command: string, args: string[], options: SpawnSyncOptions): import("node:child_process").SpawnSyncReturns<string | NonSharedBuffer>;
//# sourceMappingURL=claude-process.d.ts.map