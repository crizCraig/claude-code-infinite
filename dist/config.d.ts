export interface Config {
    polychatApiKey?: string;
    stagingPolychatApiKey?: string;
    localPolychatApiKey?: string;
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
export declare function getPolychatApiKey(): string | undefined;
export declare function setPolychatApiKey(key: string): void;
export declare function getStagingPolychatApiKey(): string | undefined;
export declare function setStagingPolychatApiKey(key: string): void;
export declare function getLocalPolychatApiKey(): string | undefined;
export declare function setLocalPolychatApiKey(key: string): void;
//# sourceMappingURL=config.d.ts.map