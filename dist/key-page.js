/**
 * Where to get a MemTree key, per environment. Its own module (no imports) so
 * the MemTree client can name it without importing the launcher's key check.
 */
// utm_source=ccc: signups from this link are attributed to ccc (polychat docs/signup_sources.md).
export const KEY_PAGE_URL = "https://polychat.co/auth?memtree=true&utm_source=ccc";
export const LOCAL_KEY_PAGE_URL = "http://local.polychat.co:5173/memtree-api";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
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