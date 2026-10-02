/** Unknown versions use the full window: never the former speculative 90%. */
export declare const STRANDED_WINDOW_FRACTION = 1;
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
    claudeVersion?: string;
    /** Injectable process check; production refuses if any possible writer exists. */
    isQuiescent?: (file: string) => boolean;
}
export declare function repairStrandedResume(claudeArgs: string[], options: ResumeRepairOptions): ResumeRepair | undefined;
export declare function resumeSessionId(args: string[]): string | undefined;
export interface UsageRepairPlan {
    lineIndexes: number[];
    recordedTokens: number;
    loweredTokens: number;
}
export declare function planUsageRepair(lines: string[], nativeOneMillionContext: boolean, claudeVersion?: string): UsageRepairPlan | undefined;
//# sourceMappingURL=resume-repair.d.ts.map