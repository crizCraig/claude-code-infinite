export type FetchMode = "production" | "staging" | "local";
export declare const USAGE: string;
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
export declare function runMemtreeFetchCommand(argv: string[], overrides?: Partial<FetchDeps>): Promise<number>;
/** The `.json` form of a MemTree page URL, or null when it is not one. */
export declare function memtreeJsonUrl(raw: string): URL | null;
/** Which saved key a host needs; mirrors the `ccc [staging|local]` modes. */
export declare function modeForUrl(url: URL): FetchMode;
export declare function keyForMode(mode: FetchMode, keys: FetchKeys): string | undefined;
//# sourceMappingURL=memtree-fetch.d.ts.map