/**
 * Opening a MemTree page in the user's default browser (`/memtree-view`).
 *
 * The OS opener runs without a shell, the URL one argument, and only for
 * http(s) URLs. It is offered only where a browser can appear in front of the
 * person who typed the command: an interactive session (not `-p` or a pipe),
 * not CI, not over SSH (the browser would open on the remote machine, if
 * anywhere), and on Linux only with a display. Elsewhere the link is printed
 * and nothing is opened.
 */
import { spawn } from "node:child_process";
import { isCi } from "./install-ping.js";

export interface OpenCommand {
  command: string;
  args: string[];
}

/** Opens a URL in the default browser; never throws, never waits. */
export type UrlOpener = (url: string) => void;

/** The spawn this module needs (child_process.spawn; a stub in tests). */
export type SpawnLike = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore"; windowsHide: boolean }
) => { on(event: "error", listener: (err: Error) => void): unknown; unref(): void };

/** Set by an SSH session; a browser opened there is on the remote machine. */
const SSH_ENV = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"];

/**
 * The opener for this CLI run, or undefined where a browser must not be opened
 * (mayOpenBrowser): then `/memtree-view` only prints its link.
 */
export function urlOpenerFor(input: {
  interactive: boolean; env: NodeJS.ProcessEnv; platform: NodeJS.Platform;
}): UrlOpener | undefined {
  return mayOpenBrowser(input) ? browserOpener(input.platform) : undefined;
}

/** Whether a browser opened now would appear in front of the user. */
export function mayOpenBrowser(input: {
  interactive: boolean; env: NodeJS.ProcessEnv; platform: NodeJS.Platform;
}): boolean {
  const { interactive, env, platform } = input;
  if (!interactive || isCi(env)) return false;
  if (SSH_ENV.some((name) => env[name])) return false;
  if (platform === "darwin" || platform === "win32") return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** An opener that runs the OS's own, detached; failures are ignored (the link is printed). */
export function browserOpener(
  platform: NodeJS.Platform,
  spawnFn: SpawnLike = spawn as unknown as SpawnLike
): UrlOpener {
  return (url) => {
    const open = browserOpenCommand(url, platform);
    if (!open) return;
    try {
      const child = spawnFn(open.command, open.args,
        { detached: true, stdio: "ignore", windowsHide: true });
      child.on("error", () => {});
      child.unref();
    } catch {
      // No opener installed: the printed link is still there.
    }
  };
}

/**
 * The command that opens `url` on `platform`, or undefined for anything but
 * an http(s) URL. Windows uses url.dll's handler (what `start` reaches) so
 * cmd.exe never parses the URL.
 */
export function browserOpenCommand(url: string, platform: NodeJS.Platform): OpenCommand | undefined {
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return undefined;
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { command: "xdg-open", args: [url] };
}
