/**
 * The link to MemTree's usage dashboard (`/usage`) for the environment this
 * ccc talks to, shown by `/memtree` and `/memtree-view`.
 *
 * Derived from the MemTree base URL, so production, staging and local each
 * link their own dashboard. The page authenticates with the browser
 * session, not the MemTree key, so the line says the browser must be signed in
 * to the same account.
 */

import { BROWSER_APP_BASE } from "./browser-links.js";

export const USAGE_PATH = "/usage";
/** Label on the usage link line, in the style of `• MemTree`. */
export const USAGE_LABEL = "• Usage";
export const USAGE_SIGN_IN_NOTE = "needs your browser signed in to MemTree (same account)";

/**
 * Production's API host serves the same app as the browser host, but browsers
 * sign in on app (its session cookie lives there), so the dashboard links it.
 */
const browserHost = new URL(BROWSER_APP_BASE).host;
const BROWSER_HOSTS: Record<string, string> = {
  "api.polychat.co": browserHost, "app.polychat.co": browserHost,
  "api.memtree.dev": browserHost, "app.memtree.dev": browserHost,
};

/** `<base>/usage`, on the browser host for production; undefined if not http(s). */
export function usageDashboardUrl(baseUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  url.host = BROWSER_HOSTS[url.host] ?? url.host;
  return `${url.origin}${USAGE_PATH}`;
}
