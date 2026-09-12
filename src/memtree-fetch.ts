/**
 * `ccc fetch <memtree-url>`: print one of the user's MemTree pages as JSON,
 * authenticated with the key ccc already stores.
 *
 * The polychat MemTree page (`/usage/memtree/<id>`) answers an unauthenticated
 * agent with a 401 that lists, in order: the loopback proxy of a running ccc
 * session, this command, and the raw key. This is the middle option — for an
 * agent on the user's machine when no ccc session is running. The tree is
 * never published; the agent simply acts as the user.
 *
 * The page URL and its `.json` twin are accepted interchangeably: the machine
 * form is always what gets printed. A `?share=` token survives untouched.
 */
import {
  getLocalPolychatApiKey,
  getPolychatApiKey,
  getStagingPolychatApiKey,
} from "./config.js";
import { CLIENT_NAME, CLIENT_VERSION } from "./memtree.js";

export type FetchMode = "production" | "staging" | "local";

/** `/usage/memtree/<request id>` with or without the `.json` suffix. */
const MEMTREE_PATH_RE = /^\/usage\/memtree\/([A-Za-z0-9-]+)(\.json)?$/;
const STAGING_HOST_PREFIX = "polychat-staging";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const ERROR_BODY_PREVIEW_CHARS = 1000;

export const USAGE =
  "usage: ccc fetch <memtree-url>\n" +
  "  Prints the MemTree at <memtree-url> as JSON (nodes, blocks, instructions),\n" +
  "  using the MemTree key saved for that host (production, staging or local).";

export interface FetchKeys {
  production?: string;
  staging?: string;
  local?: string;
}

export interface FetchDeps {
  fetch: typeof fetch;
  keys: FetchKeys;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Exit codes: 0 printed, 1 server refused, 2 bad invocation, 3 no key saved. */
export async function runMemtreeFetchCommand(
  argv: string[],
  overrides: Partial<FetchDeps> = {}
): Promise<number> {
  const deps = withDefaults(overrides);
  const raw = argv[0];
  if (!raw || raw === "--help" || raw === "-h") {
    deps.stderr(USAGE + "\n");
    return 2;
  }
  const url = memtreeJsonUrl(raw);
  if (!url) {
    deps.stderr(`ccc fetch: not a MemTree URL: ${raw}\n${USAGE}\n`);
    return 2;
  }
  const mode = modeForUrl(url);
  const key = keyForMode(mode, deps.keys);
  if (!key) {
    deps.stderr(
      `ccc fetch: no MemTree key saved for ${mode} (${url.host}). ` +
        `Run \`ccc${mode === "production" ? "" : ` ${mode}`}\` once to save one.\n`
    );
    return 3;
  }
  const response = await deps.fetch(url, {
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      "x-client": CLIENT_NAME,
      "x-client-version": CLIENT_VERSION,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    deps.stderr(
      `ccc fetch: HTTP ${response.status} from ${url.host}\n` +
        `${body.slice(0, ERROR_BODY_PREVIEW_CHARS)}\n`
    );
    return 1;
  }
  deps.stdout(body.endsWith("\n") ? body : body + "\n");
  return 0;
}

/** The `.json` form of a MemTree page URL, or null when it is not one. */
export function memtreeJsonUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const match = MEMTREE_PATH_RE.exec(url.pathname);
  if (!match || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return null;
  }
  url.pathname = `/usage/memtree/${match[1]}.json`;
  return url;
}

/** Which saved key a host needs; mirrors the `ccc [staging|local]` modes. */
export function modeForUrl(url: URL): FetchMode {
  if (LOCAL_HOSTS.has(url.hostname)) return "local";
  if (url.hostname.startsWith(STAGING_HOST_PREFIX)) return "staging";
  return "production";
}

export function keyForMode(mode: FetchMode, keys: FetchKeys): string | undefined {
  return keys[mode] || undefined;
}

function withDefaults(overrides: Partial<FetchDeps>): FetchDeps {
  return {
    fetch: overrides.fetch ?? globalThis.fetch,
    keys: overrides.keys ?? {
      production: getPolychatApiKey(),
      staging: getStagingPolychatApiKey(),
      local: getLocalPolychatApiKey(),
    },
    stdout: overrides.stdout ?? ((text) => process.stdout.write(text)),
    stderr: overrides.stderr ?? ((text) => process.stderr.write(text)),
  };
}
