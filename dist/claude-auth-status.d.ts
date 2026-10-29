/**
 * Claude Code's own answer to "am I signed in?": `claude auth status --json`
 * (Claude Code 2.x). Unlike the config-file guess in claude-auth.ts, it knows
 * where each OS keeps the credentials (macOS keychain, `.credentials.json` on
 * Linux and Windows), which env key or setting wins, and that nobody is signed
 * in at all, which the files cannot tell apart from "can't tell".
 *
 * Only four fields are read: loggedIn, authMethod, apiProvider and
 * subscriptionType (plus apiKeySource's name). The email, organization and
 * every other field are never parsed out or kept.
 */
import type { ApiKeySource, ClaudeAuthType, ClaudePlan } from "./claude-auth.js";
/**
 * How the probe went: answered, ran but said nothing usable, too slow, no such
 * command, or not asked (the session's options change its sign-in).
 */
export declare const AUTH_PROBE_RESULTS: readonly ["ok", "failed", "timeout", "unsupported", "skipped"];
export type AuthProbeResult = (typeof AUTH_PROBE_RESULTS)[number];
/** A slow Windows npm shim starts node twice; Claude Code itself answers in ~0.1 s. */
export declare const AUTH_PROBE_TIMEOUT_MS = 5000;
export interface ClaudeAuthStatus {
    /** "none": Claude Code says nobody is signed in. */
    auth: ClaudeAuthType;
    plan: ClaudePlan;
    /** The API key's source by name, for an env key or apiKeyHelper. */
    keySource?: ApiKeySource;
    /** Claude Code's "Anthropic Console account" sign-in (API usage billing). */
    console: boolean;
}
export interface AuthProbe {
    result: AuthProbeResult;
    ms: number;
    status?: ClaudeAuthStatus;
}
export interface ProbeOptions {
    /** Arguments before `auth status --json` (tests run a script through node). */
    leadingArgs?: string[];
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    now?: () => number;
}
/** False when the session's own options may sign it in differently than the probe sees. */
export declare function probeAnswersForSession(args: readonly string[]): boolean;
/** The probe for a session it can't answer for: the config files decide, nothing blocks. */
export declare function skippedProbe(): AuthProbe;
/** Run `claude auth status --json`; never throws or rejects, and is bounded by timeoutMs. */
export declare function probeClaudeAuthStatus(command: string, opts?: ProbeOptions): Promise<AuthProbe>;
/** The sign-in from `claude auth status --json` output, or undefined when it is not that. */
export declare function parseAuthStatus(stdout: string, env?: NodeJS.ProcessEnv): ClaudeAuthStatus | undefined;
//# sourceMappingURL=claude-auth-status.d.ts.map