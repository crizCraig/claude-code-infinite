import { type StatuslinePaths } from "./statusline.js";
export declare const AUTO_MARKER = "statusline-auto.json";
export interface AutoStatuslineOptions {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    /** Where the once-only record lives (ccc's config dir). */
    markerDir?: string;
    /** Whether Claude Code's shell can run `ccc` (defaults to a PATH search). */
    cccOnPath?: () => boolean;
}
/** Install or wrap the status line once; the line to tell the user, if any. */
export declare function autoInstallStatusline(paths: StatuslinePaths, options?: AutoStatuslineOptions): string | undefined;
/** Whether an executable `name` is in one of PATH's directories. */
export declare function onPath(name: string, env?: NodeJS.ProcessEnv): boolean;
//# sourceMappingURL=statusline-auto.d.ts.map