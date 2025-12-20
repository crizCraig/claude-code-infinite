import { execSync } from "node:child_process";
import { userInfo } from "node:os";

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
  if (process.platform !== "darwin") {
    console.error("OAuth token extraction is only supported on macOS");
    return null;
  }

  const username = userInfo().username;

  try {
    if (debug) {
      console.log(`[DEBUG] Reading keychain for user: ${username}`);
    }

    const result = execSync(
      `security find-generic-password -s "Claude Code-credentials" -a "${username}" -w`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );

    const credentials = JSON.parse(result.trim()) as KeychainCredentials;

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
  } catch (error) {
    if (error instanceof Error && error.message.includes("could not be found")) {
      console.error("No Claude Code credentials found in keychain");
    } else {
      console.error("Failed to retrieve credentials from keychain:", error);
    }
    return null;
  }
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

