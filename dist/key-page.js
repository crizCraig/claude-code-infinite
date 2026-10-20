/**
 * Where to get a MemTree key, per environment, and whether polychat refused
 * one. Its own module (no imports) so the MemTree client can use both without
 * importing the launcher's key check.
 */
// utm_source=ccc: signups from this link are attributed to ccc (polychat docs/signup_sources.md).
export const KEY_PAGE_URL = "https://polychat.co/auth?memtree=true&utm_source=ccc";
export const LOCAL_KEY_PAGE_URL = "http://local.polychat.co:5173/memtree-api";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// polychat's FastAPI detail for an unknown or revoked key.
const INVALID_KEY_DETAIL_RE = /"detail"\s*:\s*"[^"]*invalid api key/i;
/**
 * Whether a MemTree answer says the key itself is unknown or revoked. polychat
 * answers 401 for that. A 403 counts only with polychat's own "Invalid API
 * key" detail: a bare 403 usually comes from something in front of it
 * (Cloudflare's WAF, a corporate proxy) and says nothing about the key.
 */
export function isKeyRejected(status, bodyText = "") {
    if (status === 401)
        return true;
    return status === 403 && INVALID_KEY_DETAIL_RE.test(bodyText);
}
/** Where to get a key for the MemTree server at `baseUrl`. */
export function keyPageUrl(baseUrl) {
    try {
        return LOCAL_HOSTS.has(new URL(baseUrl).hostname) ? LOCAL_KEY_PAGE_URL : KEY_PAGE_URL;
    }
    catch {
        return KEY_PAGE_URL;
    }
}
//# sourceMappingURL=key-page.js.map