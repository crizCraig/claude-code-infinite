/**
 * Opening a MemTree page in the user's default browser (`/memtree-view`).
 *
 * The OS opener runs without a shell, the URL one argument, and only for
 * http(s) URLs. It is offered only where a browser can appear in front of the
 * person who typed the command: an interactive session (not `-p` or a pipe),
 * not CI, not over SSH (the browser would open on the remote machine, if
 * anywhere), and on Linux only with a display. Elsewhere the link is printed
 * and nothing is opened. Only a MemTree page of the environment ccc talks to
 * is opened (memtreePageUrl): another URL, even from the server, is printed.
 */
import { executablePath } from "./executable-path.js";
import { spawn } from "node:child_process";
import { system32Path } from "./claude-locate.js";
import { isCi } from "./install-ping.js";
import { usageDashboardUrl } from "./usage-link.js";
/** Set by an SSH session; a browser opened there is on the remote machine. */
const SSH_ENV = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"];
/** Paths of a MemTree page: `/m/<link id>` or `/usage/memtree/<request ref>`. */
const PAGE_PATH = /^\/(?:m|usage\/memtree)\/[A-Za-z0-9_-]+$/;
/**
 * The opener for this CLI run, or undefined where a browser must not be opened
 * (mayOpenBrowser): then `/memtree-view` only prints its link. It opens only
 * pages of the MemTree at `memtreeBaseUrl` (memtreePageUrl).
 */
export function urlOpenerFor(input) {
    if (!mayOpenBrowser(input))
        return undefined;
    const open = browserOpener(input.platform, input.spawnFn);
    return (url) => {
        if (memtreePageUrl(url, input.memtreeBaseUrl))
            open(url);
    };
}
/**
 * Whether `url` is a MemTree page of the server at `baseUrl`: its origin, or
 * the browser host its pages are served from (app.polychat.co for
 * api.polychat.co, as for the usage dashboard), a page path, no user info and
 * no query or fragment.
 */
export function memtreePageUrl(url, baseUrl) {
    let page;
    let base;
    try {
        page = new URL(url);
        base = new URL(baseUrl);
    }
    catch {
        return false;
    }
    const browser = usageDashboardUrl(baseUrl);
    const origins = new Set([base.origin, ...(browser ? [new URL(browser).origin] : [])]);
    if (["https://api.polychat.co", "https://app.polychat.co",
        "https://api.memtree.dev", "https://app.memtree.dev"].includes(base.origin)) {
        // Old server replies and saved links remain usable throughout the rollout.
        origins.add("https://app.polychat.co");
        origins.add("https://app.memtree.dev");
    }
    return (page.protocol === "https:" || page.protocol === "http:") &&
        origins.has(page.origin) && !page.username && !page.password &&
        !page.search && !page.hash && PAGE_PATH.test(page.pathname);
}
/** Whether a browser opened now would appear in front of the user. */
export function mayOpenBrowser(input) {
    const { interactive, env, platform } = input;
    if (!interactive || isCi(env))
        return false;
    if (SSH_ENV.some((name) => env[name]))
        return false;
    if (platform === "darwin" || platform === "win32")
        return true;
    return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}
/** An opener that runs the OS's own, detached; failures are ignored (the link is printed). */
export function browserOpener(platform, spawnFn = spawn) {
    return (url) => {
        const open = browserOpenCommand(url, platform);
        if (!open)
            return;
        try {
            const child = spawnFn(executablePath(open.command), open.args, { detached: true, stdio: "ignore", windowsHide: true });
            child.on("error", () => { });
            child.unref();
        }
        catch {
            // No opener installed: the printed link is still there.
        }
    };
}
/**
 * The command that opens `url` on `platform`, or undefined for anything but
 * an http(s) URL. Windows uses url.dll's handler (what `start` reaches) so
 * cmd.exe never parses the URL.
 */
export function browserOpenCommand(url, platform, env = process.env) {
    if (!/^https?:\/\/[^\s]+$/i.test(url))
        return undefined;
    if (platform === "darwin")
        return { command: "open", args: [url] };
    if (platform === "win32") {
        // System32's own copy, never one found through PATH or the working directory.
        return {
            command: system32Path(env, "rundll32.exe"),
            args: [system32Path(env, "url.dll") + ",FileProtocolHandler", url],
        };
    }
    return { command: "xdg-open", args: [url] };
}
//# sourceMappingURL=open-url.js.map