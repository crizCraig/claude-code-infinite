/**
 * A recorded size within this fraction of the window is treated as stranded.
 * Claude Code refused at 979k of 1M; the margin is wide on purpose, since
 * lowering a session that still fit only lets Claude Code send a prompt ccc
 * compresses anyway.
 */
export declare const STRANDED_WINDOW_FRACTION = 0.9;
/** The lowered size, as a fraction of the window: room for the next prompt. */
export declare const LOWERED_WINDOW_FRACTION = 0.5;
export interface ResumeRepair {
    sessionId: string;
    recordedTokens: number;
    loweredTokens: number;
    backupPath: string;
}
export interface ResumeRepairOptions {
    nativeOneMillionContext: boolean;
    projectsDir?: string;
    backupDir?: string;
    now?: Date;
}
/** Lowers a stranded resumed session's recorded usage; undefined when nothing changed. */
export declare function repairStrandedResume(claudeArgs: string[], options: ResumeRepairOptions): ResumeRepair | undefined;
/** The session id of `--resume <id>`, `--resume=<id>` or `-r <id>`; not the picker form. */
export declare function resumeSessionId(args: string[]): string | undefined;
export interface UsageRepairPlan {
    lineIndexes: number[];
    recordedTokens: number;
    loweredTokens: number;
}
/** The last response's entries and sizes, when its recorded usage strands the session. */
export declare function planUsageRepair(lines: string[], nativeOneMillionContext: boolean): UsageRepairPlan | undefined;
//# sourceMappingURL=resume-repair.d.ts.map