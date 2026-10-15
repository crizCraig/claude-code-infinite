/**
 * The auto-update install lock: at most one ccc installs at a time.
 *
 * A directory of entries, one per acquirer, each under its own random name and
 * written whole (temp file, then rename). To acquire, write your entry, then
 * look at everyone else's: if any other entry is live, remove yours and back
 * off. Of two acquirers, whichever looks second sees the first, so at most one
 * proceeds (when both look after both wrote, both back off; the next launch
 * tries again). No process ever deletes or moves a file that a live process
 * owns or may be creating: an entry is removed only by its owner, or by anyone
 * once it is stale, and a stale entry's owner is gone and never writes again.
 *
 * Each entry has one writer at a time: the launching ccc creates it, then the
 * runner (which owns it from then on) records its own pid and npm's group.
 * An entry is live while its holder process (the runner, once started) or the
 * npm process group it recorded is alive. The runner kills that group and
 * exits by a hard deadline (auto-update-runner.ts), so an entry older than
 * UPDATE_LOCK_STALE_MS whose pid still answers belongs to a reused pid.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
/** Longer than any runner can live (install timeout + kill graces + deadline). */
export const UPDATE_LOCK_STALE_MS = 60 * 60 * 1000;
/** A fresh entry whose holder is gone is stale only after this (startup grace). */
export const DEAD_HOLDER_GRACE_MS = 30 * 1000;
const ENTRY_SUFFIX = ".json";
/** Acquire the lock: the owner token, or null when another live entry exists. */
export function acquireUpdateLock(lockDir, now) {
    const token = randomUUID();
    if (!writeLockEntry(lockDir, { token, startedAt: now, pid: process.pid }))
        return null;
    const others = otherEntries(lockDir, token);
    if (others.some((entry) => !entryIsStale(entry, now))) {
        releaseUpdateLock(lockDir, token);
        return null;
    }
    for (const entry of others)
        fs.rmSync(entry.file, { force: true });
    return token;
}
/** Remove this token's entry (only its owner ever does, or anyone once stale). */
export function releaseUpdateLock(lockDir, token) {
    if (!/^[0-9a-f-]{36}$/.test(token))
        return;
    fs.rmSync(entryPath(lockDir, token), { force: true });
}
export function entryPath(lockDir, token) {
    return path.join(lockDir, `${token}${ENTRY_SUFFIX}`);
}
/** Atomic: readers see a whole entry or none. */
function writeLockEntry(lockDir, entry) {
    const tmp = path.join(lockDir, `.${entry.token}.${process.pid}.tmp`);
    try {
        fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
        fs.renameSync(tmp, entryPath(lockDir, entry.token));
        return true;
    }
    catch {
        fs.rmSync(tmp, { force: true });
        return false;
    }
}
function otherEntries(lockDir, token) {
    let names;
    try {
        names = fs.readdirSync(lockDir);
    }
    catch {
        return [];
    }
    return names
        .filter((name) => name.endsWith(ENTRY_SUFFIX) && !name.startsWith(".") && name !== `${token}${ENTRY_SUFFIX}`)
        .map((name) => readEntry(path.join(lockDir, name)))
        .filter((entry) => entry !== null);
}
/** null when the file is gone (released meanwhile). */
function readEntry(file) {
    let mtimeMs;
    try {
        mtimeMs = fs.statSync(file).mtimeMs;
    }
    catch {
        return null;
    }
    try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        if (typeof data?.token !== "string" || typeof data.startedAt !== "number")
            return { file, data: null, mtimeMs };
        const int = (v) => (Number.isInteger(v) && v > 0 ? v : undefined);
        return { file, data: { token: data.token, startedAt: data.startedAt, pid: int(data.pid), group: int(data.group) }, mtimeMs };
    }
    catch {
        return { file, data: null, mtimeMs };
    }
}
function entryIsStale(entry, now) {
    if (entry.data === null)
        return now - entry.mtimeMs > DEAD_HOLDER_GRACE_MS; // never written whole
    const age = now - entry.data.startedAt;
    if (age > UPDATE_LOCK_STALE_MS || age < -UPDATE_LOCK_STALE_MS)
        return true;
    if (age <= DEAD_HOLDER_GRACE_MS)
        return false;
    const holderAlive = entry.data.pid !== undefined && processAlive(entry.data.pid);
    const groupAlive = entry.data.group !== undefined && processAlive(-entry.data.group);
    return !holderAlive && !groupAlive;
}
/** Signal 0 to a pid (or, negative, a process group). */
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === "EPERM";
    }
}
//# sourceMappingURL=update-lock.js.map