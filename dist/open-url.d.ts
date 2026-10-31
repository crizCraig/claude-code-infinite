export interface OpenCommand {
    command: string;
    args: string[];
}
/** Opens a URL in the default browser; never throws, never waits. */
export type UrlOpener = (url: string) => void;
/** The spawn this module needs (child_process.spawn; a stub in tests). */
export type SpawnLike = (command: string, args: string[], options: {
    detached: boolean;
    stdio: "ignore";
    windowsHide: boolean;
}) => {
    on(event: "error", listener: (err: Error) => void): unknown;
    unref(): void;
};
/**
 * The opener for this CLI run, or undefined where a browser must not be opened
 * (mayOpenBrowser): then `/memtree-view` only prints its link. It opens only
 * pages of the MemTree at `memtreeBaseUrl` (memtreePageUrl).
 */
export declare function urlOpenerFor(input: {
    interactive: boolean;
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    memtreeBaseUrl: string;
    spawnFn?: SpawnLike;
}): UrlOpener | undefined;
/**
 * Whether `url` is a MemTree page of the server at `baseUrl`: its origin, or
 * the browser host its pages are served from (app.polychat.co for
 * api.polychat.co, as for the usage dashboard), a page path, no user info and
 * no query or fragment.
 */
export declare function memtreePageUrl(url: string, baseUrl: string): boolean;
/** Whether a browser opened now would appear in front of the user. */
export declare function mayOpenBrowser(input: {
    interactive: boolean;
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
}): boolean;
/** An opener that runs the OS's own, detached; failures are ignored (the link is printed). */
export declare function browserOpener(platform: NodeJS.Platform, spawnFn?: SpawnLike): UrlOpener;
/**
 * The command that opens `url` on `platform`, or undefined for anything but
 * an http(s) URL. Windows uses url.dll's handler (what `start` reaches) so
 * cmd.exe never parses the URL.
 */
export declare function browserOpenCommand(url: string, platform: NodeJS.Platform, env?: NodeJS.ProcessEnv): OpenCommand | undefined;
//# sourceMappingURL=open-url.d.ts.map