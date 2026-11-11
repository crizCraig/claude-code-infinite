import { type DesktopMode } from "./desktop-service.js";
export interface DesktopCommandDeps {
    mode: DesktopMode;
    memtreeBaseUrl: string;
    apiKey: () => string | undefined;
}
/** A `claude` for `claude mcp ...`: the terminal one, else the desktop app's own copy. */
export declare function claudeForConfig(): string | undefined;
export declare function runDesktopCommand(args: string[], deps: DesktopCommandDeps): Promise<number>;
//# sourceMappingURL=desktop-command.d.ts.map