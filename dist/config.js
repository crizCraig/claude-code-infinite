import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const CONFIG_DIR = join(homedir(), ".claude-code-infinite");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export function getConfigDir() {
    return CONFIG_DIR;
}
export function loadConfig() {
    if (!existsSync(CONFIG_FILE)) {
        return {};
    }
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
        mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
export function getPolychatApiKey() {
    return loadConfig().polychatApiKey;
}
export function setPolychatApiKey(key) {
    const config = loadConfig();
    config.polychatApiKey = key;
    saveConfig(config);
}
export function getStagingPolychatApiKey() {
    return loadConfig().stagingPolychatApiKey;
}
export function setStagingPolychatApiKey(key) {
    const config = loadConfig();
    config.stagingPolychatApiKey = key;
    saveConfig(config);
}
export function getLocalPolychatApiKey() {
    return loadConfig().localPolychatApiKey;
}
export function setLocalPolychatApiKey(key) {
    const config = loadConfig();
    config.localPolychatApiKey = key;
    saveConfig(config);
}
//# sourceMappingURL=config.js.map