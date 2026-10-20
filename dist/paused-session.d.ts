import type { AutoUpdateSetup } from "./auto-update-setup.js";
import { type ClaudeLocation } from "./claude-locate.js";
import { type Diagnostics } from "./diagnostics.js";
export type PausedSessionOptions = {
    claude: ClaudeLocation;
    claudeArgs: string[];
    interactive: boolean;
    diagnostics: Diagnostics;
    autoUpdate: AutoUpdateSetup | null;
    /** The SessionStart banner (interactive only); undefined shows none. */
    banner?: string;
};
/** Run Claude Code as if ccc were not there, then exit with its status. Never returns. */
export declare function runWithoutMemtree(opts: PausedSessionOptions): Promise<never>;
/**
 * The parent's environment minus ccc's own controls: none of the settings ccc
 * gives Claude Code under MemTree (base URL, auto-compaction off, lifted
 * context-limit refusal) apply, so Claude Code behaves exactly as without ccc.
 * A ccc started inside another ccc session (a tool, a script) inherits the outer
 * session's settings (claude-env.ts); those are dropped too.
 */
export declare function plainClaudeEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/**
 * Whether these Claude Code arguments resume or continue an earlier session. Such a
 * session may have grown past the model's window under MemTree, which plain Claude
 * Code could not send or compact, so it keeps ccc's own handling (cli-main.ts).
 */
export declare function resumesSession(args: readonly string[]): boolean;
//# sourceMappingURL=paused-session.d.ts.map