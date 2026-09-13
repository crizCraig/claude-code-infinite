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
export declare function getOAuthToken(debug?: boolean): KeychainCredentials | null;
export declare function isTokenExpired(token: ClaudeOAuthToken, debug?: boolean): boolean;
//# sourceMappingURL=keychain.d.ts.map