import { type ProxyOptions } from "./proxy.js";
import type { DesktopPaths, DesktopState } from "./desktop-setup.js";
export interface DesktopServiceOptions {
    paths: DesktopPaths;
    state: DesktopState;
    memtreeBaseUrl: string;
    apiKey: string;
    /** Test-only: a loopback mock in place of api.anthropic.com. */
    upstreamOrigin?: ProxyOptions["upstreamOrigin"];
    tracePath?: string;
    debug?: boolean;
    log?: (line: string) => void;
}
export interface RunningDesktopService {
    port: number;
    sessions: () => string[];
    /** Close sessions idle for longer than `idleMs` (the sweep's job; exposed for tests). */
    closeIdle: (idleMs?: number) => Promise<void>;
    close: () => Promise<void>;
}
/**
 * The session's directory, from Claude Code's environment block ("Primary working
 * directory: ..."): in the top-level `system` text, or (Claude Code 2.1.322) in a
 * `role: "system"` entry of `messages`. Never user or assistant text.
 */
export declare function workingDirectoryFromBody(body: string): string | undefined;
export declare function startDesktopService(opts: DesktopServiceOptions): Promise<RunningDesktopService>;
/**
 * Whether a /v1/messages body offers the memtree tools: true / false when it has a
 * `tools` list with or without them, undefined when it has none (a side call: no change).
 */
export declare function toolsOffered(body: string): boolean | undefined;
//# sourceMappingURL=desktop-service.d.ts.map