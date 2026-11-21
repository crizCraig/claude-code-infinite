interface Settings {
    statusLine?: {
        type?: string;
        command?: string;
    } | null;
    disableAllHooks?: boolean;
    allowManagedHooksOnly?: boolean;
    policyHelper?: unknown;
    managedSourcesBehavior?: string;
    env?: NodeJS.ProcessEnv;
}
export interface StatuslineSettingsOptions {
    cwd?: string;
    managedDir?: string;
    platform?: NodeJS.Platform;
    claudeArgs?: readonly string[];
}
export declare function watchStatuslineSettings(user: string, options: StatuslineSettingsOptions): () => Settings | undefined;
export {};
//# sourceMappingURL=statusline-settings.d.ts.map