import { execSync } from "node:child_process";
import { userInfo } from "node:os";
import * as fs from 'fs';

export interface ClaudeOAuthToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string;
  rateLimitTier: string;
}

export interface KeychainCredentials {
  claudeAiOauth?: ClaudeOAuthToken;
}

export function getOAuthToken(debug = false): KeychainCredentials | null {
  let credentials: KeychainCredentials | null;

  if (process.platform === "win32") {

    try {
      if (debug) {
        console.log(`[DEBUG] Fetching credentials`);
      }

      // Get credentials from the .claude file
      let path_to_creds_JSON = `${process.env.USERPROFILE}/.claude/.credentials.json`;
      credentials = JSON.parse(fs.readFileSync(path_to_creds_JSON, 'utf8')) as KeychainCredentials;

    } catch (error) {
      console.error("Failed to retrieve credentials:", error);
      return null;
    }

  } // platform = "win32"

  else if (process.platform === "linux") {

    try {
      if (debug) {
        console.log(`[DEBUG] Fetching credentials`);
      }

      // Get credentials from the .claude file
      let path_to_creds_JSON = `${process.env.HOME}/.claude/.credentials.json`;
      credentials = JSON.parse(fs.readFileSync(path_to_creds_JSON, 'utf8')) as KeychainCredentials;

    } catch (error) {
      console.error("Failed to retrieve credentials: ", error);
      return null;
    }

  } // platform = "linux"


  else if (process.platform === "darwin") {

    const username = userInfo().username;

    try {
      if (debug) {
        console.log(`[DEBUG] Reading keychain for user: ${username}`);
      }

      const result = execSync(
        `security find-generic-password -s "Claude Code-credentials" -a "${username}" -w`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );

      credentials = JSON.parse(result.trim()) as KeychainCredentials;

    } catch (error) {
      if (error instanceof Error && error.message.includes("could not be found")) {
        console.error("No Claude Code credentials found in keychain");
      } else {
        console.error("Failed to retrieve credentials from keychain:", error);
      }
      return null;
    }
  } // platform = "darwin"

  // Other platforms
  else {
    console.error("OAuth token extraction is only supported on macOS, Windows and Linux.");
    return null;
  }

  // Display debug log
  if (debug && credentials?.claudeAiOauth) {
    const token = credentials.claudeAiOauth;
    const now = Date.now();
    const expiresAt = token.expiresAt;
    const expiresInMs = expiresAt - now;
    const expiresInMins = Math.round(expiresInMs / 1000 / 60);

    console.log(`[DEBUG] Token retrieved from keychain:`);
    console.log(`  - expiresAt: ${expiresAt} (${new Date(expiresAt).toISOString()})`);
    console.log(`  - now:       ${now} (${new Date(now).toISOString()})`);
    console.log(`  - expires in: ${expiresInMins} minutes (${expiresInMs}ms)`);
    console.log(`  - subscriptionType: ${token.subscriptionType}`);
    console.log(`  - rateLimitTier: ${token.rateLimitTier}`);
    console.log(`  - scopes: ${token.scopes?.join(", ")}`);
    console.log(`  - accessToken length: ${token.accessToken?.length ?? 0}`);
    console.log(`  - refreshToken length: ${token.refreshToken?.length ?? 0}`);
  }

  return credentials;
}

export function isTokenExpired(token: ClaudeOAuthToken, debug = false): boolean {
  const now = Date.now();
  const expired = now > token.expiresAt;

  if (debug) {
    console.log(`[DEBUG] Token expiry check:`);
    console.log(`  - now:       ${now} (${new Date(now).toISOString()})`);
    console.log(`  - expiresAt: ${token.expiresAt} (${new Date(token.expiresAt).toISOString()})`);
    console.log(`  - expired:   ${expired}`);
  }

  return expired;
}

