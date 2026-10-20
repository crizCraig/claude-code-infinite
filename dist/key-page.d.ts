/**
 * Where to get a MemTree key, per environment. Its own module (no imports) so
 * the MemTree client can name it without importing the launcher's key check.
 */
export declare const KEY_PAGE_URL = "https://polychat.co/auth?memtree=true&utm_source=ccc";
export declare const LOCAL_KEY_PAGE_URL = "http://local.polychat.co:5173/memtree-api";
/** Where to get a key for the MemTree server at `baseUrl`. */
export declare function keyPageUrl(baseUrl: string): string;
//# sourceMappingURL=key-page.d.ts.map