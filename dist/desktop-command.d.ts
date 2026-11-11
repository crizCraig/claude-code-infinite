import { type DesktopMode } from "./desktop-service.js";
export interface DesktopCommandDeps {
    mode: DesktopMode;
    memtreeBaseUrl: string;
    apiKey: () => string | undefined;
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
//# sourceMappingURL=desktop-command.d.ts.map