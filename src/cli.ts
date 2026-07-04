#!/usr/bin/env node

import spawn from "cross-spawn";
import { exec } from "node:child_process";
import * as readline from "node:readline";
import { getOAuthToken, isTokenExpired, type ClaudeOAuthToken } from "./keychain.js";
import {
  getPolychatApiKey,
  setPolychatApiKey,
  getLocalPolychatApiKey,
  setLocalPolychatApiKey,
  getStagingPolychatApiKey,
  setStagingPolychatApiKey,
} from "./config.js";

const POLYCHAT_BASE_URL = "https://polychat.co/cc";
const STAGING_BASE_URL = "https://polychat-staging-421312241218.us-west2.run.app/cc";
const LOCAL_BASE_URL = "http://localhost:8080/cc";
const POLYCHAT_AUTH_URL = "https://polychat.co/auth?memtree=true";

function openUrl(url: string): void {
  const platform = process.platform;
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "explorer" : "xdg-open";

  platform === "win32" ? exec(`${command} "${url}"`, { shell: 'cmd.exe' }) : exec(`${command} "${url}"`);
}

async function promptForApiKey(mode: 'production' | 'staging' | 'local'): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const url = mode === 'local'
    ? "http://local.polychat.co:5173/memtree-api"
    : POLYCHAT_AUTH_URL;

  // Wait for user to press enter before opening the URL
  await new Promise<void>((resolve) => {
    rl.question(`\nPress Enter to open your browser to obtain your Memtree API key...`, () => {
      resolve();
    });
  });

  // Open the URL in the default browser
  openUrl(url);

  return new Promise((resolve) => {
    rl.question("Copy your API key and paste it here: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function refreshOAuthToken(debug: boolean): Promise<ClaudeOAuthToken | null> {
  console.log("\x1b[1;33m🔄 OAuth token expired. Refreshing...\x1b[0m\n");

  // Get current expiry to detect when it changes
  const currentCredentials = getOAuthToken(false);
  const currentExpiry = currentCredentials?.claudeAiOauth?.expiresAt ?? 0;

  // Spawn claude in background - this triggers the OAuth refresh flow
  if (debug) {
    console.log("[DEBUG] Spawning 'claude' to trigger token refresh...");
  }

  const child = spawn("claude", [], {
    stdio: "ignore",
    detached: false,
  });

  // Poll keychain until token is refreshed or timeout
  const maxWaitMs = 10000;
  const pollIntervalMs = 100;
  let elapsed = 0;
  let refreshedToken: ClaudeOAuthToken | null = null;

  while (elapsed < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    elapsed += pollIntervalMs;

    const creds = getOAuthToken(false);
    if (creds?.claudeAiOauth && creds.claudeAiOauth.expiresAt !== currentExpiry) {
      refreshedToken = creds.claudeAiOauth;
      if (debug) {
        console.log(`[DEBUG] Token refreshed after ${elapsed}ms`);
      }
      break;
    }
  }

  // Kill the claude process
  if (debug) {
    console.log("[DEBUG] Killing claude process...");
  }
  child.kill("SIGTERM");

  // Wait for process to exit
  await new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
    if (child.exitCode !== null) resolve();
  });

  if (debug) {
    console.log("[DEBUG] Claude process terminated");
  }

  if (!refreshedToken) {
    console.error("OAuth token refresh timed out.");
    console.error("Please run 'claude' directly to re-authenticate.");
    return null;
  }

  if (isTokenExpired(refreshedToken, debug)) {
    console.error("OAuth token is still expired after refresh attempt.");
    console.error("Please run 'claude' directly to re-authenticate.");
    return null;
  }

  console.log("\x1b[1;32m✓ OAuth token refreshed successfully!\x1b[0m\n");
  return refreshedToken;
}

function printBanner() {
  console.log(`\n\x1b[1;38;5;209mClaude Code Infinite:\x1b[0m \x1b[38;5;48mMaximizing Claude's intelligence with context-management from \x1b]8;;https://MemTree.dev\x1b\\MemTree.dev\x1b]8;;\x1b\\\x1b[0m\n`);
}

async function main() {
  // Check for environment mode and debug flag
  const args = process.argv.slice(2);
  const isDebugMode = args.includes("--debug");
  const forceTokenRefresh = process.env.DEBUG_FORCE_EXPIRED === "1";
  const filteredArgs = args.filter((arg) => arg !== "--debug");

  const mode: 'production' | 'staging' | 'local' =
    filteredArgs[0] === "local" ? "local" :
    filteredArgs[0] === "staging" ? "staging" :
    "production";

  const claudeArgs = mode !== "production" ? filteredArgs.slice(1) : filteredArgs;

  printBanner();

  if (isDebugMode) {
    console.log("\x1b[1;36m🔍 DEBUG MODE\x1b[0m\n");
  }

  if (mode === "local") {
    console.log("\x1b[1;33m🏠 LOCAL MODE\x1b[0m\n");
  } else if (mode === "staging") {
    console.log("\x1b[1;35m🚧 STAGING MODE\x1b[0m\n");
  }

  // Get OAuth token from keychain (optional - we can work without it)
  const credentials = getOAuthToken(isDebugMode);
  let oauthToken = credentials?.claudeAiOauth ?? null;

  if (!oauthToken) {
    console.log("\x1b[1;33m⚠️  No Claude Code OAuth credentials found.\x1b[0m");
    console.log("\x1b[33m   Claude Code is much cheaper with an Anthropic subscription.\x1b[0m");
    console.log("\x1b[33m   MemTree.dev makes it even cheaper by reducing messages sent to Anthropic.\x1b[0m");
    console.log("\x1b[33m   Run '/login' to log in and get discounted rates.\x1b[0m\n");
  } else if (forceTokenRefresh || isTokenExpired(oauthToken, isDebugMode)) {
    // If token is expired, attempt to refresh it by launching Claude
    const refreshedToken = await refreshOAuthToken(isDebugMode);
    if (!refreshedToken) {
      console.log("\x1b[1;33m⚠️  Could not refresh OAuth token. Continuing without it.\x1b[0m");
      console.log("\x1b[33m   Claude Code is much cheaper with an Anthropic subscription.\x1b[0m");
      console.log("\x1b[33m   MemTree.dev makes it even cheaper by reducing messages sent to Anthropic.\x1b[0m\n");
      oauthToken = null;
    } else {
      oauthToken = refreshedToken;
    }
  }

  // Get or prompt for Polychat API key (separate keys for each environment)
  let polychatApiKey =
    mode === "local" ? getLocalPolychatApiKey() :
    mode === "staging" ? getStagingPolychatApiKey() :
    getPolychatApiKey();

  if (!polychatApiKey) {
    polychatApiKey = await promptForApiKey(mode);
    if (!polychatApiKey) {
      console.error("POLYCHAT_API_KEY is required.");
      process.exit(1);
    }
    if (mode === "local") {
      setLocalPolychatApiKey(polychatApiKey);
    } else if (mode === "staging") {
      setStagingPolychatApiKey(polychatApiKey);
    } else {
      setPolychatApiKey(polychatApiKey);
    }
    console.log("API key saved.\n");
  }

  // Build auth token (with or without OAuth)
  const combinedAuthToken = oauthToken
    ? `${oauthToken.accessToken},${polychatApiKey}`
    : polychatApiKey;

  // Choose base URL based on mode
  const baseUrl =
    mode === "local" ? LOCAL_BASE_URL :
    mode === "staging" ? STAGING_BASE_URL :
    POLYCHAT_BASE_URL;

  // Spawn claude with the environment variables
  const child = spawn("claude", claudeArgs, {
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: combinedAuthToken,
    },
    stdio: "inherit",
  });

  child.on("error", (err: Error) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("Could not find 'claude' command. Make sure Claude Code is installed.");
    } else {
      console.error("Failed to start claude:", err.message);
    }
    process.exit(1);
  });

  child.on("exit", (code: number | null) => {
    process.exit(code ?? 0);
  });
}

main().catch(console.error);
