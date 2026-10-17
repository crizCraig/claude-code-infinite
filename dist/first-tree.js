/**
 * Whether the user has ever been shown a MemTree, so the first tree they ever
 * see can say what to do with it (FIRST_EVER_HINT). A marker file in the ccc
 * config dir records that it was shown. A user who had trees before this
 * notice existed has pages in memtree-links.json for other sessions, and so
 * counts as having seen one.
 *
 * Every failure reads as "not the first": the hint is a nicety, and showing it
 * twice is worse than never.
 */
import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "./config.js";
export const FIRST_TREE_MARKER_FILE = "first-tree-shown.json";
export class FirstTreeMarker {
    linkStore;
    filePath;
    constructor(linkStore, filePath = path.join(getConfigDir(), FIRST_TREE_MARKER_FILE)) {
        this.linkStore = linkStore;
        this.filePath = filePath;
    }
    isFirstEver(sessionId) {
        try {
            if (fs.existsSync(this.filePath))
                return false;
            return !this.linkStore?.hasOtherSession(sessionId);
        }
        catch {
            return false;
        }
    }
    markShown(_sessionId) {
        try {
            if (fs.existsSync(this.filePath))
                return;
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            const shownAt = new Date().toISOString();
            fs.writeFileSync(this.filePath, JSON.stringify({ shownAt }), { mode: 0o600, flag: "wx" });
        }
        catch {
            // Another ccc wrote it first, or the dir is read-only: either way, done.
        }
    }
}
//# sourceMappingURL=first-tree.js.map