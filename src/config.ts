import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  polychatApiKey?: string;
  stagingPolychatApiKey?: string;
  localPolychatApiKey?: string;
}

const CONFIG_DIR = join(homedir(), ".claude-code-infinite");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
// The config holds MemTree API keys: owner-only, so other users on a shared
// machine cannot read them. Ignored on Windows, where ACLs govern access.
const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    return {};
  }

  restrictConfigPermissions();
  try {
    const content = readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(content) as Config;
  } catch {
    return {};
  }
}

export function saveConfig(config: Config): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: CONFIG_DIR_MODE });
  }

  restrictConfigPermissions(); // before writing, so a loose old file never gets new keys
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: CONFIG_FILE_MODE });
  restrictConfigPermissions();
}

/** Tighten a config written before keys were owner-only (the mode above applies on create). */
function restrictConfigPermissions(): void {
  for (const [path, mode] of [[CONFIG_DIR, CONFIG_DIR_MODE], [CONFIG_FILE, CONFIG_FILE_MODE]] as const) {
    try {
      chmodSync(path, mode);
    } catch {
      // Best effort: a missing file or a filesystem without modes is not fatal.
    }
  }
}

export function getPolychatApiKey(): string | undefined {
  return loadConfig().polychatApiKey;
}

export function setPolychatApiKey(key: string): void {
  const config = loadConfig();
  config.polychatApiKey = key;
  saveConfig(config);
}

export function getStagingPolychatApiKey(): string | undefined {
  return loadConfig().stagingPolychatApiKey;
}

export function setStagingPolychatApiKey(key: string): void {
  const config = loadConfig();
  config.stagingPolychatApiKey = key;
  saveConfig(config);
}

export function getLocalPolychatApiKey(): string | undefined {
  return loadConfig().localPolychatApiKey;
}

export function setLocalPolychatApiKey(key: string): void {
  const config = loadConfig();
  config.localPolychatApiKey = key;
  saveConfig(config);
}
