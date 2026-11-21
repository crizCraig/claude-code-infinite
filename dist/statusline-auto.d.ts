import { type StatuslineSettingsOptions } from "./statusline-settings.js";
import { type StatuslinePaths } from "./statusline.js";
export declare const AUTO_MARKER = "statusline-auto.json";
export interface AutoStatuslineOptions extends StatuslineSettingsOptions {
    env?: NodeJS.ProcessEnv;
    /** Where the once-only record lives (ccc's config dir). */
    markerDir?: string;
    /** Whether Claude Code's shell can run `ccc` (defaults to a PATH search). */
    cccOnPath?: () => boolean;
}
/** Install once, then recheck the effective configuration when Stop considers a link. */
export declare function prepareSessionStatusline(interactive: boolean, paths: StatuslinePaths, options?: AutoStatuslineOptions): {
    text?: string;
    showsLink: boolean;
    refresh: boolean;
};
/** Install or wrap the status line once; the line to tell the user, if any. */
export declare function autoInstallStatusline(paths: StatuslinePaths, options?: AutoStatuslineOptions): string | undefined;
/** Whether an executable `name` is in one of PATH's directories. */
export declare function onPath(name: string, env?: NodeJS.ProcessEnv): boolean;
//# sourceMappingURL=statusline-auto.d.ts.map