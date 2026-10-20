/**
 * Where to get a MemTree key, per environment, and whether polychat refused
 * one. Its own module (no imports) so the MemTree client can use both without
 * importing the launcher's key check.
 */
export declare const KEY_PAGE_URL = "https://polychat.co/auth?memtree=true&utm_source=ccc";
export declare const LOCAL_KEY_PAGE_URL = "http://local.polychat.co:5173/memtree-api";
/**
 * Whether a MemTree answer says the key itself is unknown or revoked. polychat
 * answers 401 for that. A 403 counts only with polychat's own "Invalid API
 * key" detail: a bare 403 usually comes from something in front of it
 * (Cloudflare's WAF, a corporate proxy) and says nothing about the key.
 */
export declare function isKeyRejected(status: number | undefined, bodyText?: string): boolean;
/** Where to get a key for the MemTree server at `baseUrl`. */
export declare function keyPageUrl(baseUrl: string): string;
//# sourceMappingURL=key-page.d.ts.map