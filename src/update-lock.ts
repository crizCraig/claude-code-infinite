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
 * back to the update hint (auto-update.ts).
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
}

/** Acquire the lock: the owner token, or null when another live entry exists. */
export function acquireUpdateLock(lockDir: string, now: number): string | null {
  const token = randomUUID();
  if (!writeLockEntry(lockDir, { token, startedAt: now, pid: process.pid })) return null;
  const others = otherEntries(lockDir, token);
  if (others.some((entry) => !entryIsStale(entry, now))) {
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
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof data?.token !== "string" || typeof data.startedAt !== "number") return { file, data: null, mtimeMs };
    const int = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : undefined);
    const entry: LockEntry = {
      token: data.token,
      startedAt: data.startedAt,
      pid: int(data.pid),
      runner: int(data.runner),
      group: int(data.group),
    };
    return { file, data: entry, mtimeMs };
  } catch {
    return { file, data: null, mtimeMs };
  }
}

/** Stale only when no process it names is alive (or it was never written whole). */
function entryIsStale(entry: ReadEntry, now: number): boolean {
  if (entry.data === null) return now - entry.mtimeMs > DEAD_HOLDER_GRACE_MS;
  const { pid, runner, group } = entry.data;
  if (pid !== undefined && processAlive(pid)) return false;
  if (runner !== undefined && processAlive(runner)) return false;
  if (group !== undefined && processAlive(-group)) return false;
  return true;
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
