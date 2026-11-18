import type { CccEnvironment } from "./cli-args.js";
export interface Config {
    /** false remembers a legacy credential that was discarded on a subsequent write. */
    polychatApiKey?: string | false;
    stagingPolychatApiKey?: string | false;
    localPolychatApiKey?: string | false;
    /** false turns off the startup check for a newer ccc on npm (update-check.ts). */
    updateCheck?: boolean;
    /** false keeps the update hint but never installs in the background (auto-update.ts). */
    autoUpdate?: boolean;
    /** false turns off client diagnostics (diagnostics.ts). */
    diagnostics?: boolean;
    /**
     * true runs sessions in HTTPS-proxy mode (Remote Control; https-proxy-eligibility.ts)
     * where it can work. CCC_HTTPS_PROXY_MODE=1/0 overrides it.
     */
    httpsProxyMode?: boolean;
}
export declare function getConfigDir(): string;
export declare function loadConfig(): Config;
export declare function saveConfig(config: Config): void;
declare const keyFields: {
    readonly production: "polychatApiKey";
    readonly staging: "stagingPolychatApiKey";
    readonly local: "localPolychatApiKey";
};
/** false lets startup continue without using a malformed legacy value as a credential. */
export declare function savedKeyFor(mode: keyof typeof keyFields): string | false | undefined;
export declare function getPolychatApiKey(): string | undefined;
export declare function setPolychatApiKey(key: string): void;
export declare function getStagingPolychatApiKey(): string | undefined;
export declare function setStagingPolychatApiKey(key: string): void;
export declare function getLocalPolychatApiKey(): string | undefined;
export declare function setLocalPolychatApiKey(key: string): void;
/** MemTree's API host for a mode; CCC_LOCAL_BASE_URL moves local mode's (tests: a free port). */
export declare function memtreeBaseUrlFor(mode: CccEnvironment, env?: NodeJS.ProcessEnv): string;
/** The saved MemTree key for a mode (separate keys per environment). */
export declare function storedApiKey(mode: CccEnvironment): string | undefined;
export {};
//# sourceMappingURL=config.d.ts.map