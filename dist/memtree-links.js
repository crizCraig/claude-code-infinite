/**
 * The newest MemTree page per Claude Code session, kept on disk so a resumed
 * session (`claude --resume`, `/resume`) can show its link before the first
 * new turn. A fresh ccc process starts with no in-memory state, and the page
 * URL comes only from compress responses, so without this a resumed session
 * shows no link until its next compressed turn.
 *
 * Small JSON file, read and rewritten whole; bounded to the most recent
 * sessions. Every failure is swallowed: the link is a convenience and must
 * never break a request or a hook.
 */
import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "./config.js";
export const MEMTREE_LINKS_MAX_SESSIONS = 200;
export class MemtreeLinkStore {
    filePath;
    maxSessions;
    constructor(filePath = path.join(getConfigDir(), "memtree-links.json"), maxSessions = MEMTREE_LINKS_MAX_SESSIONS) {
        this.filePath = filePath;
        this.maxSessions = maxSessions;
    }
    get(sessionId) {
        const entry = this.readAll()[sessionId];
        return isStoredLink(entry) ? entry : undefined;
    }
    put(sessionId, link) {
        try {
            const all = this.readAll();
            all[sessionId] = { ...link, updatedAt: new Date().toISOString() };
            const kept = Object.entries(all)
                .filter(([, v]) => isStoredLink(v))
                .sort(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt))
                .slice(0, this.maxSessions);
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            // Write-then-rename so a concurrent reader never sees a torn file.
            const tmp = `${this.filePath}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)), { mode: 0o600 });
            fs.renameSync(tmp, this.filePath);
        }
        catch {
            // A lost link is a missed convenience, never an error.
        }
    }
    readAll() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        }
        catch {
            return {};
        }
    }
}
function isStoredLink(value) {
    const v = value;
    return (!!v &&
        typeof v === "object" &&
        typeof v.url === "string" &&
        /^https?:\/\//.test(v.url) &&
        typeof v.index === "string" &&
        v.index.length > 0 &&
        typeof v.compressed === "boolean" &&
        typeof v.updatedAt === "string");
}
//# sourceMappingURL=memtree-links.js.map