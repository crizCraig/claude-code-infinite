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
 * back to the update hint (auto-update.ts). The runner marks its entry
 * `spawning` before starting npm and clears it once npm's group is recorded:
 * an entry left `spawning` by a dead runner may have an unrecorded npm
 * running, so it stays live (fail closed) and, after an hour, the hint shows.
 * Removing update.lock.d by hand clears it.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Longer than a healthy runner lives (install timeout + kill graces + deadline). */
export const UPDATE_LOCK_STALE_MS = 60 * 60 * 1000;
/** An unreadable entry (never written whole) is garbage only after this. */
export const DEAD_HOLDER_GRACE_MS = 30 * 1000;
const ENTRY_SUFFIX = ".json";

export interface LockEntry {
  token: string;
  startedAt: number;
  /** The launching ccc (or the runner, once it owns the entry). */
  pid?: number;
  /** The runner, recorded by the launcher right after spawning it. */
  runner?: number;
  /** The npm process group the runner started, while it may be alive. */
  group?: number;
  /** Set by the runner just before starting npm, cleared once `group` is recorded. */
  spawning?: boolean;
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
export function acquireUpdateLock(
  lockDir: string,
  now: number,
  /** Test-only: runs between the liveness checks and the second read. */
  afterLivenessCheck?: () => void
): string | null {
  const token = randomUUID();
  if (!writeLockEntry(lockDir, { token, startedAt: now, pid: process.pid })) return null;
  const others = otherEntries(lockDir, token);
  const allStale = others.every((entry) => entryIsStale(entry, now));
  afterLivenessCheck?.();
  if (!allStale || others.some((entry) => changedSince(entry))) {
    releaseUpdateLock(lockDir, token);
    return null;
  }
  for (const entry of others) fs.rmSync(entry.file, { force: true });
  return token;
}

/** Remove this token's entry (only its owner ever does, or anyone once stale). */
export function releaseUpdateLock(lockDir: string, token: string): void {
  if (!/^[0-9a-f-]{36}$/.test(token)) return;
  fs.rmSync(entryPath(lockDir, token), { force: true });
}

/**
 * The launcher's one write after creating the entry: the runner's pid, so the
 * entry stays live while the runner exists, even before it has run a line.
 */
export function setLockRunner(lockDir: string, token: string, runnerPid: number): boolean {
  const entry = readEntry(entryPath(lockDir, token))?.data;
  if (entry?.token !== token) return false;
  return writeLockEntry(lockDir, { ...entry, runner: runnerPid });
}

/** When the oldest live entry was taken, or null when the lock is free. */
export function liveLockSince(lockDir: string, now: number): number | null {
  const live = otherEntries(lockDir, "").filter((e) => e.data && !entryIsStale(e, now));
  return live.length ? Math.min(...live.map((e) => e.data!.startedAt)) : null;
}

export function entryPath(lockDir: string, token: string): string {
  return path.join(lockDir, `${token}${ENTRY_SUFFIX}`);
}

/** Atomic: readers see a whole entry or none. */
function writeLockEntry(lockDir: string, entry: LockEntry): boolean {
  const tmp = path.join(lockDir, `.${entry.token}.${process.pid}.tmp`);
  try {
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
    fs.renameSync(tmp, entryPath(lockDir, entry.token));
    return true;
  } catch {
    fs.rmSync(tmp, { force: true });
    return false;
  }
}

interface ReadEntry {
  file: string;
  data: LockEntry | null;
  mtimeMs: number;
  /** The bytes read, to tell whether the entry changed since. */
  raw: string;
}

/** True when the entry is no longer exactly what was read (gone counts as unchanged). */
function changedSince(entry: ReadEntry): boolean {
  const again = readEntry(entry.file);
  return again !== null && (again.raw !== entry.raw || again.mtimeMs !== entry.mtimeMs);
}

function otherEntries(lockDir: string, token: string): ReadEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(lockDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(ENTRY_SUFFIX) && !name.startsWith(".") && name !== `${token}${ENTRY_SUFFIX}`)
    .map((name) => readEntry(path.join(lockDir, name)))
    .filter((entry): entry is ReadEntry => entry !== null);
}

/** null when the file is gone (released meanwhile). */
function readEntry(file: string): ReadEntry | null {
  let mtimeMs: number;
  let raw: string;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return { file, data: parseEntry(raw), mtimeMs, raw };
}

function parseEntry(raw: string): LockEntry | null {
  try {
    const data = JSON.parse(raw);
    if (typeof data?.token !== "string" || typeof data.startedAt !== "number") return null;
    const int = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : undefined);
    return {
      token: data.token,
      startedAt: data.startedAt,
      pid: int(data.pid),
      runner: int(data.runner),
      group: int(data.group),
      ...(data.spawning === true ? { spawning: true } : {}),
    };
  } catch {
    return null;
  }
}

/** Stale only when no process it names is alive (or it was never written whole). */
function entryIsStale(entry: ReadEntry, now: number): boolean {
  if (entry.data === null) return now - entry.mtimeMs > DEAD_HOLDER_GRACE_MS;
  const { pid, runner, group } = entry.data;
  if (pid !== undefined && processAlive(pid)) return false;
  if (runner !== undefined && processAlive(runner)) return false;
  // Windows has no process groups: the runner records npm's own pid there.
  if (group !== undefined && processAlive(process.platform === "win32" ? group : -group)) {
    return false;
  }
  // Its runner died while starting npm: npm may be running unrecorded.
  return entry.data.spawning !== true;
}

/** Signal 0 to a pid (or, negative, a process group). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
