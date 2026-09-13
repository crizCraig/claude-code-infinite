/** Wrapper-only command-line options consumed by `ccc` before Claude's `--`. */
export interface WrapperArgs {
    claudeArgs: string[];
    debug: boolean;
}
/** Whether Claude's own print mode was requested before its `--` separator. */
export declare function isPrintInvocation(args: string[]): boolean;
/**
 * Consume ccc's own flags only before the conventional `--` separator. Values
 * after it are literal Claude arguments/prompts, even when they look like ccc
 * flags.
 */
export declare function parseWrapperArgs(args: string[]): WrapperArgs;
//# sourceMappingURL=cli-args.d.ts.map