import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMemtreeKey } from "./key-page.js";
const CONFIG_DIR = join(homedir(), ".claude-code-infinite");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
// The config holds MemTree API keys: owner-only, so other users on a shared
// machine cannot read them. Ignored on Windows, where ACLs govern access.
const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;
export function getConfigDir() {
    return CONFIG_DIR;
}
export function loadConfig() {
    if (!existsSync(CONFIG_FILE)) {
        return {};
    }
    restrictConfigPermissions();
    try {
        const content = readFileSync(CONFIG_FILE, "utf-8");
        return JSON.parse(content);
    }
    catch {
        return {};
    }
}
export function saveConfig(config) {
    if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true, mode: CONFIG_DIR_MODE });
    }
    restrictConfigPermissions(); // before writing, so a loose old file never gets new keys
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: CONFIG_FILE_MODE });
    restrictConfigPermissions();
}
/** Tighten a config written before keys were owner-only (the mode above applies on create). */
function restrictConfigPermissions() {
    for (const [path, mode] of [[CONFIG_DIR, CONFIG_DIR_MODE], [CONFIG_FILE, CONFIG_FILE_MODE]]) {
        try {
            chmodSync(path, mode);
        }
        catch {
            // Best effort: a missing file or a filesystem without modes is not fatal.
        }
    }
}
export function getPolychatApiKey() {
    const key = loadConfig().polychatApiKey;
    return isMemtreeKey(key) ? key : undefined;
}
export function setPolychatApiKey(key) {
    const config = loadConfig();
    config.polychatApiKey = key;
    saveConfig(config);
}
export function getStagingPolychatApiKey() {
    const key = loadConfig().stagingPolychatApiKey;
    return isMemtreeKey(key) ? key : undefined;
}
export function setStagingPolychatApiKey(key) {
    const config = loadConfig();
    config.stagingPolychatApiKey = key;
    saveConfig(config);
}
export function getLocalPolychatApiKey() {
    const key = loadConfig().localPolychatApiKey;
    return isMemtreeKey(key) ? key : undefined;
}
export function setLocalPolychatApiKey(key) {
    const config = loadConfig();
    config.localPolychatApiKey = key;
    saveConfig(config);
}
// MemTree (polychat) API hosts — /v1/context_memory lives at the app root.
const POLYCHAT_BASE_URL = "https://api.polychat.co";
const STAGING_BASE_URL = "https://polychat-staging-421312241218.us-west2.run.app";
const LOCAL_BASE_URL = "http://localhost:8080";
/** MemTree's API host for a mode; CCC_LOCAL_BASE_URL moves local mode's (tests: a free port). */
export function memtreeBaseUrlFor(mode, env = process.env) {
    return mode === "local" ? (env.CCC_LOCAL_BASE_URL || LOCAL_BASE_URL) :
        mode === "staging" ? STAGING_BASE_URL :
            POLYCHAT_BASE_URL;
}
/** The saved MemTree key for a mode (separate keys per environment). */
export function storedApiKey(mode) {
    return mode === "local" ? getLocalPolychatApiKey() :
        mode === "staging" ? getStagingPolychatApiKey() :
            getPolychatApiKey();
}
//# sourceMappingURL=config.js.map