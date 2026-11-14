import { type HttpsProxyModeOptions } from "./https-proxy-mode.js";
/** What claudeChildEnv sets for proxy mode in place of the base URL. */
export interface HttpsProxyChild {
    /** HTTPS_PROXY: the loopback with the per-session token. */
    proxyUrl: string;
    /** NODE_EXTRA_CA_CERTS: the user's extra CAs, then the session CA. */
    caBundlePath: string;
    /** CLAUDE_ENV_FILE: sourced by Claude Code before each Bash command. */
    bashEnvPath: string;
    /** NO_PROXY / no_proxy with api.anthropic.com entries removed (only those set). */
    noProxy: Partial<Record<NoProxyVar, string>>;
}
export interface HttpsProxySession {
    /** For startProxy's `httpsProxyMode`. */
    proxyOptions: HttpsProxyModeOptions & {
        onModelCall: () => void;
    };
    /** Writes the Bash env file for the proxy's port; what Claude Code's env needs. */
    childFor(port: number): HttpsProxyChild;
    /** A one-time warning when prompts go by with no model call through ccc. */
    promptLine(): string | undefined;
    cleanup(): void;
}
declare const NO_PROXY_VARS: readonly ["NO_PROXY", "no_proxy"];
type NoProxyVar = typeof NO_PROXY_VARS[number];
export declare function startHttpsProxySession(env: NodeJS.ProcessEnv, tracePath?: string, root?: string): HttpsProxySession;
/**
 * NO_PROXY / no_proxy for Claude Code: entries that would match api.anthropic.com
 * (`*`, `anthropic.com`, `.anthropic.com`, `*.anthropic.com`, the host itself, with or
 * without a port) are dropped, or Claude Code would bypass ccc. Only changed ones.
 */
export declare function sanitizedNoProxy(env: NodeJS.ProcessEnv): Partial<Record<NoProxyVar, string>>;
interface BashEnvInput {
    parentEnv: NodeJS.ProcessEnv;
    port: number;
    bundlePath: string;
    noProxy: Partial<Record<NoProxyVar, string>>;
}
/** The POSIX sh script Claude Code sources before each Bash command (see the header). */
export declare function bashEnvScript(input: BashEnvInput): string;
export declare function shellQuote(value: string): string;
/**
 * Settings that change mid-session (a proxy in a settings `env`, the sandbox turned on)
 * can send Claude Code's model calls past ccc with no error. Two prompts with no model
 * call through ccc between them get one warning.
 */
export declare class ModelCallWatch {
    private promptsWithoutCall;
    private warned;
    modelCall(): void;
    promptLine(): string | undefined;
}
export declare const MODEL_CALLS_MISSING: string;
export {};
//# sourceMappingURL=https-proxy-session.d.ts.map