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
/** Longer than any runner can live (install timeout + kill graces + deadline). */
export declare const UPDATE_LOCK_STALE_MS: number;
/** A fresh entry whose holder is gone is stale only after this (startup grace). */
export declare const DEAD_HOLDER_GRACE_MS: number;
export interface LockEntry {
    token: string;
    startedAt: number;
    /** The holder: the launching ccc, then the runner. */
    pid?: number;
    /** The npm process group the runner started, while it may be alive. */
    group?: number;
}
/** Acquire the lock: the owner token, or null when another live entry exists. */
export declare function acquireUpdateLock(lockDir: string, now: number): string | null;
/** Remove this token's entry (only its owner ever does, or anyone once stale). */
export declare function releaseUpdateLock(lockDir: string, token: string): void;
export declare function entryPath(lockDir: string, token: string): string;
//# sourceMappingURL=update-lock.d.ts.map