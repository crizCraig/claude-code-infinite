import { type DesktopMode, type DesktopState } from "./desktop-setup.js";
export interface DesktopCommandDeps {
    mode: DesktopMode;
    memtreeBaseUrl: string;
    apiKey: () => string | undefined;
    /** Asks for and saves a MemTree key (a terminal only); undefined when none was given. */
    promptForKey?: () => Promise<string | undefined>;
}
/**
 * A `claude` for `claude mcp ...`: the terminal one, else the desktop app's own copy.
 * Desktop keeps verified installs at `<version>/<checksum prefix>/claude`
 * (`.../claude.app/Contents/MacOS/claude` on macOS); older layouts had `<version>/claude`.
 */
export declare function claudeForConfig(root?: string): string | undefined;
/** Desktop's downloaded Claude Code binaries, oldest version first. */
export declare function desktopClaudeBinaries(root: string): string[];
export declare function runDesktopCommand(args: string[], deps: DesktopCommandDeps): Promise<number>;
/** Is the service answering on its port, with its token? */
export declare function serviceHealth(state: DesktopState, timeoutMs?: number): Promise<{
    up: true;
    sessions: number;
} | {
    up: false;
    detail: string;
}>;
/** What a stopped service means for Desktop sessions, and how to get it back. */
export declare function serviceDownText(mode: DesktopMode, state: DesktopState, detail: string): string;
/**
 * One line for a terminal ccc start when this mode's desktop service is set up but not
 * answering (undefined otherwise). A loopback check, bounded at 300 ms.
 */
export declare function desktopServiceDownLine(mode: DesktopMode): Promise<string | undefined>;
//# sourceMappingURL=desktop-command.d.ts.map