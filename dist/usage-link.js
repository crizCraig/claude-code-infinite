/**
 * The link to polychat's usage dashboard (`/usage`) for the environment this
 * ccc talks to, shown by `/memtree` and `/memtree-view`.
 *
 * Derived from the MemTree base URL, so production, staging and local each
 * link their own dashboard. The page authenticates with polychat's browser
 * session, not the MemTree key, so the line says the browser must be signed in
 * to the same account.
 */
export const USAGE_PATH = "/usage";
/** Label on the usage link line, in the style of `• MemTree`. */
export const USAGE_LABEL = "• Usage";
export const USAGE_SIGN_IN_NOTE = "needs your browser signed in to polychat (same account)";
/**
 * Production's API host serves the same app as app.polychat.co, but browsers
 * sign in on app (its session cookie lives there), so the dashboard links it.
 */
const BROWSER_HOSTS = { "api.polychat.co": "app.polychat.co" };
/** `<base>/usage`, on the browser host for production; undefined if not http(s). */
export function usageDashboardUrl(baseUrl) {
    let url;
    try {
        url = new URL(baseUrl);
    }
    catch {
        return undefined;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
        return undefined;
    url.host = BROWSER_HOSTS[url.host] ?? url.host;
    return `${url.origin}${USAGE_PATH}`;
}
//# sourceMappingURL=usage-link.js.map