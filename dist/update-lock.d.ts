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
 * Each entry has one writer at a time. The launching ccc creates it and,
 * right after spawning the runner, records the runner's pid; the runner waits
 * for that handoff before it writes or runs anything (auto-update-runner.ts),
 * and from then on owns the entry, adding npm's process group while one runs.
 * An entry is live while any process it names is alive (the launcher, the
 * runner, or npm's group), however old: a lock is never taken from a live
 * installer by age. A pid reused by an unrelated process can keep it held;
 * callers treat a lock held for over UPDATE_LOCK_STALE_MS as stuck and fall
 * back to the update hint (auto-update.ts). One window is not covered: a
 * runner killed outright (SIGKILL) between starting npm and recording npm's
 * group leaves that npm unrecorded.
 */
/** Longer than a healthy runner lives (install timeout + kill graces + deadline). */
export declare const UPDATE_LOCK_STALE_MS: number;
/** An unreadable entry (never written whole) is garbage only after this. */
export declare const DEAD_HOLDER_GRACE_MS: number;
export interface LockEntry {
    token: string;
    startedAt: number;
    /** The launching ccc (or the runner, once it owns the entry). */
    pid?: number;
    /** The runner, recorded by the launcher right after spawning it. */
    runner?: number;
    /** The npm process group the runner started, while it may be alive. */
    group?: number;
}
/**
 * Acquire the lock: the owner token, or null when another entry is live (or
 * changed while being judged).
 *
 * Each other entry is read, its named processes checked, then read again: it
 * counts as stale only if every named process was gone and the entry is
 * unchanged. Only named processes ever write an entry (the launcher hands
 * over to the runner, which adds npm's group), and a process found gone
 * before the second read cannot write after it, so an entry unchanged across
 * the check stays dead and is safe to remove. A change (say, a handoff landing
 * mid-check) means it may have a live owner: back off.
 */
export declare function acquireUpdateLock(lockDir: string, now: number, 
/** Test-only: runs between the liveness checks and the second read. */
afterLivenessCheck?: () => void): string | null;
/** Remove this token's entry (only its owner ever does, or anyone once stale). */
export declare function releaseUpdateLock(lockDir: string, token: string): void;
/**
 * The launcher's one write after creating the entry: the runner's pid, so the
 * entry stays live while the runner exists, even before it has run a line.
 */
export declare function setLockRunner(lockDir: string, token: string, runnerPid: number): boolean;
/** When the oldest live entry was taken, or null when the lock is free. */
export declare function liveLockSince(lockDir: string, now: number): number | null;
export declare function entryPath(lockDir: string, token: string): string;
//# sourceMappingURL=update-lock.d.ts.map