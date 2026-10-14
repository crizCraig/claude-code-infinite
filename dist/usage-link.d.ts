/**
 * The link to polychat's usage dashboard (`/usage`) for the environment this
 * ccc talks to, shown by `/memtree` and `/memtree-view`.
 *
 * Derived from the MemTree base URL, so production, staging and local each
 * link their own dashboard. The page authenticates with polychat's browser
 * session, not the MemTree key, so the line says the browser must be signed in
 * to the same account.
 */
export declare const USAGE_PATH = "/usage";
/** Label on the usage link line, in the style of `• MemTree`. */
export declare const USAGE_LABEL = "\u2022 Usage";
export declare const USAGE_SIGN_IN_NOTE = "needs your browser signed in to polychat (same account)";
/** `<base>/usage`, on the browser host for production; undefined if not http(s). */
export declare function usageDashboardUrl(baseUrl: string): string | undefined;
//# sourceMappingURL=usage-link.d.ts.map