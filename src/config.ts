import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  polychatApiKey?: string;
  localPolychatApiKey?: string;
}

const CONFIG_DIR = join(homedir(), ".claude-code-infinite");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    return {};
  }

  try {
    const content = readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(content) as Config;
  } catch {
    return {};
  }
}

export function saveConfig(config: Config): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function getPolychatApiKey(): string | undefined {
  return loadConfig().polychatApiKey;
}

export function setPolychatApiKey(key: string): void {
  const config = loadConfig();
  config.polychatApiKey = key;
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
