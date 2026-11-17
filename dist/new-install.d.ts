export declare const NEW_INSTALL_FILE = "first-question-new-install";
/** Any existing entry counts as ccc state, including empty session dirs or bad config. */
export declare function hasNoInstallState(configDir: string): boolean;
/** Snapshot before startup writes state/keys. Old install_id/first_run_pending aren't proof. */
export declare function takeNewInstall(configDir: string): boolean;
//# sourceMappingURL=new-install.d.ts.map