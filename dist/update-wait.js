/**
 * Windows starts a background update as ccc exits (auto-update.ts), and the
 * usual next step is to start ccc again at once, which would land while npm
 * is replacing the package. cli.ts waits here first: while the update lock
 * has a recent entry naming a live process, up to WAIT_MS, saying so once.
 *
 * Node built-ins only, and loaded before cli-main.js: it must run while the
 * rest of the package may be mid-replacement (a failure to load it is ignored).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
export const UPDATE_WAIT_MS = 30_000;
/** Entries older than this are not a just-started install (a stuck lock shows the hint instead). */
export const FRESH_ENTRY_MS = 5 * 60_000;
/** Resolves when no fresh live install holds the lock, or after waitMs. True if it waited. */
export async function waitForUpdateToFinish(opts = {}) {
    const lockDir = opts.lockDir ?? path.join(os.homedir(), ".claude-code-infinite", "update.lock.d");
    const now = opts.now ?? Date.now;
    const until = now() + (opts.waitMs ?? UPDATE_WAIT_MS);
    let waited = false;
    while (installRunning(lockDir, now()) && now() < until) {
        if (!waited)
            opts.onWait?.();
        waited = true;
        await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 250));
    }
    return waited;
}
/** A lock entry started in the last FRESH_ENTRY_MS whose launcher, runner or npm is alive. */
export function installRunning(lockDir, now) {
    let names;
    try {
        names = fs.readdirSync(lockDir);
    }
    catch {
        return false;
    }
    return names
        .filter((name) => name.endsWith(".json") && !name.startsWith("."))
        .some((name) => freshAndLive(path.join(lockDir, name), now));
}
function freshAndLive(file, now) {
    try {
        const entry = JSON.parse(fs.readFileSync(file, "utf8"));
        if (typeof entry?.startedAt !== "number" || now - entry.startedAt > FRESH_ENTRY_MS)
            return false;
        return [entry.pid, entry.runner, entry.group].some((pid) => Number.isInteger(pid) && alive(pid));
    }
    catch {
        return false;
    }
}
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === "EPERM";
    }
}
//# sourceMappingURL=update-wait.js.map