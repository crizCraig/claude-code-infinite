import { type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
interface Invocation {
    command: string;
    args: string[];
    options?: Pick<SpawnOptions, "windowsVerbatimArguments" | "env">;
}
export declare function claudeInvocation(command: string, args: string[], env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, cwd?: string): Invocation;
export declare function spawnClaude(command: string, args: string[], options: SpawnOptions): import("node:child_process").ChildProcess;
export declare function spawnClaudeSync(command: string, args: string[], options: SpawnSyncOptions): import("node:child_process").SpawnSyncReturns<string | NonSharedBuffer>;
export {};
//# sourceMappingURL=claude-process.d.ts.map