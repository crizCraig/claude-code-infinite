/**
 * The session's newest MemTree link, cached on disk for Claude Code's status line.
 *
 * The end-of-turn link shows only when a turn ends after a new tree finished, so in long
 * sessions it rarely appears, and the newest-tree lookup behind it (memtree-newest.ts) can
 * take 7-22 s on the server. A status line must never wait on that: Claude Code runs it
 * after every message. So the proxy writes the link to one small file per session whenever
 * it learns a newer one (a compress answer's page, or the newest-tree lookup answering in
 * the background), and the status line only reads that file (statusline.ts, or the shell
 * one-liner in the README).
 *
 * `<config dir>/statusline/<session id>.url`: the URL and a newline. Written then renamed,
 * so a reader never sees half a file; bounded to the newest MAX_FILES sessions. Every
 * failure is swallowed: the link is a convenience.
 */
import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "./config.js";
export const STATUS_LINK_DIR = "statusline";
export const STATUS_LINK_SUFFIX = ".url";
/** Session ids Claude Code uses (UUIDs); anything else never names a file. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_FILES = 200;
/** Prune at most this often (a directory listing per write would be wasteful). */
const PRUNE_EVERY_WRITES = 20;
export function statusLinkDir() {
    return path.join(getConfigDir(), STATUS_LINK_DIR);
}
/** The cached link for `sessionId`, or undefined. Never throws. */
export function readStatusLink(sessionId, dir = statusLinkDir()) {
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId))
        return undefined;
    try {
        const url = fs.readFileSync(path.join(dir, `${sessionId}${STATUS_LINK_SUFFIX}`), "utf-8")
            .trim();
        return /^https?:\/\/\S+$/.test(url) ? url : undefined;
    }
    catch {
        return undefined;
    }
}
export class StatusLinkFiles {
    dir;
    maxFiles;
    written = new Map();
    writes = 0;
    constructor(dir = statusLinkDir(), maxFiles = MAX_FILES) {
        this.dir = dir;
        this.maxFiles = maxFiles;
    }
    /** Record `url` as the session's link; writes only when it changed. Never throws. */
    write(sessionId, url) {
        if (!sessionId || !SESSION_ID.test(sessionId) || !url || !/^https?:\/\/\S+$/.test(url))
            return;
        // Unchanged and still on disk as written (another ccc process may have pruned it, or
        // written an older link for the same resumed session).
        if (this.written.get(sessionId) === url && readStatusLink(sessionId, this.dir) === url)
            return;
        const file = path.join(this.dir, `${sessionId}${STATUS_LINK_SUFFIX}`);
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, `${url}\n`, { mode: 0o600 });
            fs.renameSync(tmp, file);
            this.remember(sessionId, url);
            if (++this.writes % PRUNE_EVERY_WRITES === 1)
                this.prune();
        }
        catch {
            // A missed status-line link is never an error.
        }
    }
    remember(sessionId, url) {
        this.written.delete(sessionId);
        this.written.set(sessionId, url);
        while (this.written.size > this.maxFiles)
            this.written.delete(this.written.keys().next().value);
    }
    /** Keep the newest maxFiles links (by modification time). */
    prune() {
        const files = fs.readdirSync(this.dir)
            .filter((name) => name.endsWith(STATUS_LINK_SUFFIX))
            .map((name) => ({ name, at: mtime(path.join(this.dir, name)) }))
            .sort((a, b) => b.at - a.at);
        for (const { name } of files.slice(this.maxFiles)) {
            try {
                fs.unlinkSync(path.join(this.dir, name));
            }
            catch {
                // Another process pruned it first.
            }
        }
    }
}
function mtime(file) {
    try {
        return fs.statSync(file).mtimeMs;
    }
    catch {
        return 0;
    }
}
//# sourceMappingURL=status-link.js.map