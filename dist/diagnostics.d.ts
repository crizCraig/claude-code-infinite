/**
 * Client diagnostics: why a session stalls, without ever sending its content
 * (polychat plans/2026-10-16_PLAN_ccc_client_diagnostics.md).
 *
 * What is sent: ccc / Claude Code / Node versions, install method, OS and arch,
 * terminal type, locale, and lifecycle and error events made of enums, status
 * codes, sizes and timings (diagnostics-schema.ts is the allowlist; polychat
 * enforces it again). Never prompts, paths, hostnames, usernames, env values,
 * keys or error message text.
 *
 * Hard constraints, like reqlog.ts: never throw and never block. Events go into
 * a capped in-memory queue; batches are POSTed fire-and-forget (every
 * FLUSH_INTERVAL_MS, after the sign-in prompt, and at shutdown under a short
 * bound); a failed POST drops its batch.
 *
 * Off with CCC_NO_DIAGNOSTICS=1, `"diagnostics": false` in the config,
 * DO_NOT_TRACK=1, or Claude Code's DISABLE_TELEMETRY /
 * CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC.
 */
import { type DiagnosticsErrorCode, type DiagnosticsEvent } from "./diagnostics-schema.js";
import type { RequestLogSink, RequestRecord } from "./reqlog.js";
import { type ClaudeAuthType } from "./claude-auth.js";
import type { RateLimitInfo } from "./rate-limit.js";
export declare const DIAGNOSTICS_PATH = "/v1/ccc/diagnostics";
export declare const INSTALL_ID_FILE = "install_id";
/**
 * Written by the npm install ping (install-ping.ts) when it created the install id,
 * so ccc's first launch still records first_run; removed by that launch.
 */
export declare const FIRST_RUN_PENDING_FILE = "first_run_pending";
export declare const FLUSH_INTERVAL_MS = 30000;
export declare const MAX_QUEUE = 200;
export declare const BATCH_SIZE = 50;
export declare const SEND_TIMEOUT_MS = 3000;
export declare const SHUTDOWN_FLUSH_MS = 1000;
/** Repeats of one error kind (event + status) reported per process. */
export declare const MAX_REPEATS = 5;
/** What the proxy and the launcher need: record an event, never fail. */
export interface DiagnosticsRecorder {
    record(name: string, fields?: Record<string, unknown>): void;
}
export interface DiagnosticsOptions {
    baseUrl: string;
    configDir: string;
    clientName: string;
    clientVersion: string;
    env?: NodeJS.ProcessEnv;
    config?: {
        diagnostics?: boolean;
    };
    apiKey?: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
    flushIntervalMs?: number;
    maxQueue?: number;
}
/** False when any opt-out is set. */
export declare function diagnosticsEnabled(env: NodeJS.ProcessEnv, config: {
    diagnostics?: boolean;
}): boolean;
export declare class Diagnostics implements DiagnosticsRecorder {
    private readonly opts;
    readonly enabled: boolean;
    /** True when this launch created the install id (the machine's first run). */
    readonly firstRun: boolean;
    /** Events dropped because the queue was full. */
    dropped: number;
    private readonly installId;
    private readonly queue;
    private readonly inFlight;
    private readonly repeats;
    private context;
    private apiKey;
    private timer;
    constructor(opts: DiagnosticsOptions);
    setApiKey(apiKey: string | undefined): void;
    /** Add context fields (allowlisted; later values win). */
    setContext(fields: Record<string, unknown>): void;
    record(name: string, fields?: Record<string, unknown>): void;
    /** Like record, but at most MAX_REPEATS times per `key` in this process. */
    recordLimited(key: string, name: string, fields?: Record<string, unknown>): void;
    /** Flush every FLUSH_INTERVAL_MS without keeping the process alive. */
    start(): void;
    /** Send what is queued now; fire-and-forget. */
    flushNow(): void;
    /** Shutdown: send what is queued and wait for in-flight sends, at most `timeoutMs`. */
    flush(timeoutMs?: number): Promise<void>;
    /** The exact JSON body a batch of these events is sent as (tests read it). */
    batchBody(events: DiagnosticsEvent[]): string;
    private send;
    private headers;
    private track;
    private now;
}
/**
 * Tee for the request log: every record still goes to `inner` unchanged, and a
 * few named numeric/enum fields of some records become diagnostics events.
 * Records are never copied: they can hold content (client.systemHead, URLs).
 */
export declare class DiagnosticsRequestSink implements RequestLogSink {
    private readonly inner;
    private readonly diagnostics;
    /** Anthropic refused for no credit (claude-auth.ts), with the request's sign-in type. */
    private readonly onCreditBalanceTooLow?;
    /** The sign-in type a request showed: subscription or api_key (claude-plan-warning.ts). */
    private readonly onClaudeAuth?;
    /** Anthropic answered a turn's request (2xx): a remembered credit refusal is stale. */
    private readonly onUpstreamOk?;
    /**
     * A main-conversation turn's answer (mainTurn): its 429/529 (rate-limit.ts), or
     * null for a 2xx; `startedAt` (epoch ms) is when that request reached ccc.
     */
    private readonly onMainTurnAnswer?;
    /** Milliseconds since this launch's sign-in warning (sign-in-notice.ts), if one was shown. */
    private readonly sinceWarningMs?;
    private firstRequest;
    private firstTurn;
    private firstAnswer;
    constructor(inner: RequestLogSink | undefined, diagnostics: Diagnostics, 
    /** Anthropic refused for no credit (claude-auth.ts), with the request's sign-in type. */
    onCreditBalanceTooLow?: ((auth: ClaudeAuthType | undefined) => void) | undefined, 
    /** The sign-in type a request showed: subscription or api_key (claude-plan-warning.ts). */
    onClaudeAuth?: ((auth: ClaudeAuthType) => void) | undefined, 
    /** Anthropic answered a turn's request (2xx): a remembered credit refusal is stale. */
    onUpstreamOk?: (() => void) | undefined, 
    /**
     * A main-conversation turn's answer (mainTurn): its 429/529 (rate-limit.ts), or
     * null for a 2xx; `startedAt` (epoch ms) is when that request reached ccc.
     */
    onMainTurnAnswer?: ((rateLimit: RateLimitInfo | null, startedAt: number) => void) | undefined, 
    /** Milliseconds since this launch's sign-in warning (sign-in-notice.ts), if one was shown. */
    sinceWarningMs?: (() => number | undefined) | undefined);
    log(record: RequestRecord): void;
    private observe;
    private observeMessages;
    private observeMessageErrors;
    private observeMemtree;
}
/** Record a launcher error by code only: Node's errno and class name, never its message. */
export declare function recordError(diagnostics: DiagnosticsRecorder, code: DiagnosticsErrorCode, err: unknown): void;
/** The install id, created (0600) on first use; null when it cannot be read or written. */
export declare function readOrCreateInstallId(configDir: string): {
    id: string;
    created: boolean;
} | null;
/** True (and the marker removed) when the install ping left a first-run marker. */
export declare function takeFirstRunMarker(configDir: string): boolean;
/** Environment context; every value is mapped onto an allowlisted shape. */
export declare function environmentContext(env: NodeJS.ProcessEnv, cccVersion: string): Record<string, unknown>;
export declare function terminalName(env: NodeJS.ProcessEnv): string;
export declare function localeName(): string;
//# sourceMappingURL=diagnostics.d.ts.map