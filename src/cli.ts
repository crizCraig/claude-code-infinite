#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import * as readline from "node:readline";
import { getOAuthToken, isTokenExpired, type ClaudeOAuthToken } from "./keychain.js";
import {
  getPolychatApiKey,
  setPolychatApiKey,
  getLocalPolychatApiKey,
  setLocalPolychatApiKey,
} from "./config.js";

const POLYCHAT_BASE_URL = "https://polychat.co/cc";
const LOCAL_BASE_URL = "http://localhost:8080/cc";
const POLYCHAT_AUTH_URL = "https://polychat.co/auth?memtree=true";

async function promptForApiKey(isLocal: boolean): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  if (isLocal) {
    console.log("\nLocal POLYCHAT_API_KEY not found.");
    console.log("Please visit: http://local.polychat.co:5173/memtree-api");
    console.log("to obtain your local API key.\n");
  } else {
    console.log("\nPOLYCHAT_API_KEY not found.");
    console.log(`Please visit: ${POLYCHAT_AUTH_URL}`);
    console.log("to obtain your API key.\n");
  }

  const prompt = isLocal ? "Enter your local POLYCHAT_API_KEY: " : "Enter your POLYCHAT_API_KEY: ";

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
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

  // Spawn claude interactively - this triggers the OAuth refresh flow
  if (debug) {
    console.log("[DEBUG] Spawning 'claude' to trigger token refresh...");
  }

  const child = spawn("claude", [], {
    stdio: "inherit",
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
  const banner = `
\x1b[38;5;209m ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗     ██████╗ ██████╗ ██████╗ ███████╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝    ██╔════╝██╔═══██╗██╔══██╗██╔════╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗      ██║     ██║   ██║██║  ██║█████╗
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝      ██║     ██║   ██║██║  ██║██╔══╝
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗    ╚██████╗╚██████╔╝██████╔╝███████╗
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝     ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
               \x1b[1;38;2;255;165;0m██╗███╗   ██╗███████╗██╗███╗   ██╗██╗████████╗███████╗
               ██║████╗  ██║██╔════╝██║████╗  ██║██║╚══██╔══╝██╔════╝
               ██║██╔██╗ ██║█████╗  ██║██╔██╗ ██║██║   ██║   █████╗
               ██║██║╚██╗██║██╔══╝  ██║██║╚██╗██║██║   ██║   ██╔══╝
               ██║██║ ╚████║██║     ██║██║ ╚████║██║   ██║   ███████╗
               ╚═╝╚═╝  ╚═══╝╚═╝     ╚═╝╚═╝  ╚═══╝╚═╝   ╚═╝   ╚══════╝\x1b[0m

        \x1b[1;38;5;48m✦ Infinitely-long coding sessions for Claude, powered by \x1b]8;;https://MemTree.dev\x1b\\MemTree.dev\x1b]8;;\x1b\\\x1b[0m
           \x1b[1;38;5;87m✦ Get the speed and quality of a fresh chat with every message\x1b[0m
                   \x1b[1;38;5;87m✦ Retrieves relevant info from entire thread \x1b[0m
`;
  console.log(banner);
}

async function main() {
  // Check for local mode and debug flag
  const args = process.argv.slice(2);
  const isDebugMode = args.includes("--debug");
  const filteredArgs = args.filter((arg) => arg !== "--debug");
  const isLocalMode = filteredArgs[0] === "local";
  const claudeArgs = isLocalMode ? filteredArgs.slice(1) : filteredArgs;

  printBanner();

  if (isDebugMode) {
    console.log("\x1b[1;36m🔍 DEBUG MODE\x1b[0m\n");
  }

  if (isLocalMode) {
    console.log("\x1b[1;33m🏠 LOCAL MODE\x1b[0m\n");
  }

  // Get OAuth token from keychain
  const credentials = getOAuthToken(isDebugMode);

  if (!credentials?.claudeAiOauth) {
    console.error("Could not retrieve Claude OAuth credentials from keychain.");
    console.error("Make sure you're logged into Claude Code first.");
    process.exit(1);
  }

  let oauthToken = credentials.claudeAiOauth;

  // If token is expired, attempt to refresh it by launching Claude
  if (isTokenExpired(oauthToken, isDebugMode)) {
    const refreshedToken = await refreshOAuthToken(isDebugMode);
    if (!refreshedToken) {
      process.exit(1);
    }
    oauthToken = refreshedToken;
  }

  // Get or prompt for Polychat API key (separate keys for local vs production)
  let polychatApiKey = isLocalMode ? getLocalPolychatApiKey() : getPolychatApiKey();

  if (!polychatApiKey) {
    polychatApiKey = await promptForApiKey(isLocalMode);
    if (!polychatApiKey) {
      console.error("POLYCHAT_API_KEY is required.");
      process.exit(1);
    }
    if (isLocalMode) {
      setLocalPolychatApiKey(polychatApiKey);
    } else {
      setPolychatApiKey(polychatApiKey);
    }
    console.log("API key saved.\n");
  }

  // Build combined auth token
  const combinedAuthToken = `${oauthToken.accessToken},${polychatApiKey}`;

  // Choose base URL based on mode
  const baseUrl = isLocalMode ? LOCAL_BASE_URL : POLYCHAT_BASE_URL;

  // Spawn claude with the environment variables
  const child = spawn("claude", claudeArgs, {
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: combinedAuthToken,
    },
    stdio: "inherit",
  });

  child.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("Could not find 'claude' command. Make sure Claude Code is installed.");
    } else {
      console.error("Failed to start claude:", err.message);
    }
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

main().catch(console.error);
