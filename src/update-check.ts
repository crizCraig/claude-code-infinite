/**
 * Startup check for a newer claude-code-infinite release on npm.
 *
 * The check only detects; installing is auto-update.ts, which acts on this
 * result in the background where that is safe. The result is surfaced
 * inside Claude Code through the SessionStart banner (see notices.ts) — the
 * pre-launch terminal is covered by the TUI within a second, so a line printed
 * there is never read. Bounded by a short timeout and silent on every failure
 * (registry down, offline, malformed JSON, timeout) so startup is never gated
 * on the registry. The registry's answer is cached for a day, so most starts
 * make no request at all. `CCC_NO_UPDATE_CHECK=1` (or the older
 * `CCC_SKIP_UPDATE_CHECK=1`), or `"updateCheck": false` in
 * ~/.claude-code-infinite/config.json, disables the check entirely (and
 * with it auto-update).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const PACKAGE_NAME = "claude-code-infinite";
export const NPM_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
export const NO_UPDATE_CHECK_ENV = "CCC_NO_UPDATE_CHECK";
/** The original opt-out name, still honored. */
export const SKIP_UPDATE_CHECK_ENV = "CCC_SKIP_UPDATE_CHECK";
export const UPGRADE_COMMAND = `npm i -g ${PACKAGE_NAME}@latest`;
export const UPDATE_CHECK_TIMEOUT_MS = 1500;
export const UPDATE_CHECK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_CACHE_FILE = "update-check.json";

// Dotted numeric core with an optional pre-release/build suffix, as npm
// publishes it. Anything else (a tag name, an error page) is ignored.
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]{0,40})?$/;

export interface UpdateAvailable {
  /** Newest version on the registry's `latest` tag. */
  latest: string;
  /** The running client's version. */
  current: string;
  /** How to update this install by hand, when not UPGRADE_COMMAND (auto-update.ts). */
  command?: string;
}

/** The config.json fields this check reads. */
export interface UpdateCheckConfig {
  updateCheck?: boolean;
}

interface UpdateCheckCache {
  checkedAt: number;
  latest: string;
}

export interface UpdateCheckOptions {
  currentVersion: string;
  env?: NodeJS.ProcessEnv;
  config?: UpdateCheckConfig;
  /** Where the registry's answer is cached; no caching when omitted. */
  cacheFile?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  url?: string;
}

/**
 * Resolve to the newer version when the registry's `latest` is strictly ahead
 * of `currentVersion`, else null. Never rejects.
 */
export async function checkForUpdate(
  opts: UpdateCheckOptions
): Promise<UpdateAvailable | null> {
  if (!updateCheckEnabled(opts.env ?? process.env, opts.config ?? {})) return null;
  const current = parseVersion(opts.currentVersion);
  if (current === null) return null;
  const latestRaw = await latestVersion(opts);
  const latest = latestRaw === null ? null : parseReleaseVersion(latestRaw);
  if (latest === null || compareVersions(latest, current) <= 0) return null;
  return { latest: latestRaw as string, current: opts.currentVersion };
}

/** False when the user opted out by env (either name) or config. */
export function updateCheckEnabled(
  env: NodeJS.ProcessEnv,
  config: UpdateCheckConfig
): boolean {
  if (env[NO_UPDATE_CHECK_ENV] === "1" || env[SKIP_UPDATE_CHECK_ENV] === "1") return false;
  return config.updateCheck !== false;
}

/** The registry's `latest`, from a fresh cache or a bounded fetch; null on any failure. */
async function latestVersion(opts: UpdateCheckOptions): Promise<string | null> {
  const now = (opts.now ?? Date.now)();
  const cached = opts.cacheFile ? readCache(opts.cacheFile) : null;
  const age = cached ? now - cached.checkedAt : -1;
  if (cached && age >= 0 && age < UPDATE_CHECK_CACHE_TTL_MS) return cached.latest;
  const latest = await fetchLatestVersion(opts);
  if (latest !== null && opts.cacheFile) writeCache(opts.cacheFile, { checkedAt: now, latest });
  return latest;
}

async function fetchLatestVersion(opts: UpdateCheckOptions): Promise<string | null> {
  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const res = await fetchImpl(opts.url ?? NPM_LATEST_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    const version = typeof body?.version === "string" ? body.version : "";
    return parseVersion(version) === null ? null : version;
  } catch {
    // Registry unreachable, timed out, or answered with something that is
    // not a package document: no update is knowable, so say nothing.
    return null;
  }
}

function readCache(file: string): UpdateCheckCache | null {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<UpdateCheckCache>;
    if (typeof data?.checkedAt !== "number" || typeof data.latest !== "string") return null;
    if (parseVersion(data.latest) === null) return null;
    return { checkedAt: data.checkedAt, latest: data.latest };
  } catch {
    return null;
  }
}

/** Best effort and atomic: a failed write only means the next start fetches again. */
function writeCache(file: string, cache: UpdateCheckCache): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Nothing more to clean up.
    }
  }
}

/** A release version only: prereleases (`1.2.3-beta.1`) are never offered. */
function parseReleaseVersion(version: string): [number, number, number] | null {
  if (/^v?\d+\.\d+\.\d+-/.test(version.trim())) return null;
  return parseVersion(version);
}

/** Parse `1.2.3` (optionally `v`-prefixed / suffixed) into numeric parts. */
export function parseVersion(version: string): [number, number, number] | null {
  const match = VERSION_RE.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Numeric per-component compare: negative when a < b, positive when a > b. */
export function compareVersions(
  a: [number, number, number],
  b: [number, number, number]
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}
