/**
 * Startup check for a newer claude-code-infinite release on npm.
 *
 * Detect-and-tell only: ccc is Claude Code's parent process, so a silent
 * `npm -g` write mid-session is never acceptable. The result is surfaced
 * inside Claude Code through the SessionStart banner (see notices.ts) — the
 * pre-launch terminal is covered by the TUI within a second, so a line printed
 * there is never read. Bounded by a short timeout and silent on every failure
 * (registry down, offline, malformed JSON, timeout) so startup is never gated
 * on the registry. `CCC_SKIP_UPDATE_CHECK=1` disables the fetch entirely.
 */

export const PACKAGE_NAME = "claude-code-infinite";
export const NPM_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
export const SKIP_UPDATE_CHECK_ENV = "CCC_SKIP_UPDATE_CHECK";
export const UPGRADE_COMMAND = `npm install -g ${PACKAGE_NAME}`;
const UPDATE_CHECK_TIMEOUT_MS = 2000;

// Dotted numeric core with an optional pre-release/build suffix, as npm
// publishes it. Anything else (a tag name, an error page) is ignored.
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]{0,40})?$/;

export interface UpdateAvailable {
  /** Newest version on the registry's `latest` tag. */
  latest: string;
  /** The running client's version. */
  current: string;
}

export interface UpdateCheckOptions {
  currentVersion: string;
  env?: NodeJS.ProcessEnv;
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
  const env = opts.env ?? process.env;
  if (env[SKIP_UPDATE_CHECK_ENV] === "1") return null;
  const current = parseVersion(opts.currentVersion);
  if (current === null) return null;
  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const res = await fetchImpl(opts.url ?? NPM_LATEST_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    const latestRaw = typeof body?.version === "string" ? body.version : "";
    const latest = parseVersion(latestRaw);
    if (latest === null || compareVersions(latest, current) <= 0) return null;
    return { latest: latestRaw, current: opts.currentVersion };
  } catch {
    // Registry unreachable, timed out, or answered with something that is
    // not a package document: no update is knowable, so say nothing.
    return null;
  }
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
