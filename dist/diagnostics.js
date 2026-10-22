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
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { DIAGNOSTICS_SCHEMA, TERMINALS, TURN_TYPES, errnoName, errorClassName, sanitizeContext, sanitizeEvent, threePartVersion, } from "./diagnostics-schema.js";
import { CREDIT_BALANCE_TOO_LOW } from "./claude-auth.js";
export const DIAGNOSTICS_PATH = "/v1/ccc/diagnostics";
export const INSTALL_ID_FILE = "install_id";
export const FLUSH_INTERVAL_MS = 30_000;
export const MAX_QUEUE = 200;
export const BATCH_SIZE = 50;
export const SEND_TIMEOUT_MS = 3_000;
export const SHUTDOWN_FLUSH_MS = 1_000;
/** Repeats of one error kind (event + status) reported per process. */
export const MAX_REPEATS = 5;
const OPT_OUT_ENV = [
    "CCC_NO_DIAGNOSTICS", "DO_NOT_TRACK", "DISABLE_TELEMETRY",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** False when any opt-out is set. */
export function diagnosticsEnabled(env, config) {
    if (config.diagnostics === false)
        return false;
    return !OPT_OUT_ENV.some((name) => envFlagSet(env[name]));
}
export class Diagnostics {
    opts;
    enabled;
    /** True when this launch created the install id (the machine's first run). */
    firstRun;
    /** Events dropped because the queue was full. */
    dropped = 0;
    installId;
    queue = [];
    inFlight = new Set();
    repeats = new Map();
    context = {};
    apiKey;
    timer;
    constructor(opts) {
        this.opts = opts;
        const env = opts.env ?? process.env;
        let enabled = diagnosticsEnabled(env, opts.config ?? {});
        const install = enabled ? readOrCreateInstallId(opts.configDir) : null;
        if (install === null)
            enabled = false;
        this.enabled = enabled;
        this.installId = install?.id ?? null;
        this.firstRun = install?.created === true;
        this.apiKey = opts.apiKey;
        if (enabled)
            this.context = sanitizeContext(environmentContext(env, opts.clientVersion));
    }
    setApiKey(apiKey) {
        this.apiKey = apiKey;
    }
    /** Add context fields (allowlisted; later values win). */
    setContext(fields) {
        if (!this.enabled)
            return;
        try {
            this.context = { ...this.context, ...sanitizeContext(fields) };
        }
        catch {
            // Never break the caller.
        }
    }
    record(name, fields = {}) {
        if (!this.enabled)
            return;
        try {
            const event = sanitizeEvent(name, fields, this.now());
            if (event === null)
                return;
            if (this.queue.length >= (this.opts.maxQueue ?? MAX_QUEUE)) {
                this.dropped++;
                return;
            }
            this.queue.push(event);
        }
        catch {
            // Never break the caller.
        }
    }
    /** Like record, but at most MAX_REPEATS times per `key` in this process. */
    recordLimited(key, name, fields = {}) {
        const seen = this.repeats.get(key) ?? 0;
        if (seen >= MAX_REPEATS)
            return;
        this.repeats.set(key, seen + 1);
        this.record(name, fields);
    }
    /** Flush every FLUSH_INTERVAL_MS without keeping the process alive. */
    start() {
        if (!this.enabled || this.timer)
            return;
        this.timer = setInterval(() => this.flushNow(), this.opts.flushIntervalMs ?? FLUSH_INTERVAL_MS);
        this.timer.unref();
    }
    /** Send what is queued now; fire-and-forget. */
    flushNow() {
        if (!this.enabled)
            return;
        while (this.queue.length > 0) {
            this.track(this.send(this.queue.splice(0, BATCH_SIZE)));
        }
    }
    /** Shutdown: send what is queued and wait for in-flight sends, at most `timeoutMs`. */
    async flush(timeoutMs = SHUTDOWN_FLUSH_MS) {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = undefined;
        this.flushNow();
        if (this.inFlight.size === 0)
            return;
        let timer;
        await Promise.race([
            Promise.allSettled([...this.inFlight]),
            new Promise((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
            }),
        ]);
        if (timer)
            clearTimeout(timer);
    }
    /** The exact JSON body a batch of these events is sent as (tests read it). */
    batchBody(events) {
        return JSON.stringify({
            schema: DIAGNOSTICS_SCHEMA, install_id: this.installId, context: this.context, events,
        });
    }
    async send(events) {
        try {
            const doFetch = this.opts.fetchImpl ?? fetch;
            await doFetch(`${this.opts.baseUrl.replace(/\/$/, "")}${DIAGNOSTICS_PATH}`, {
                method: "POST",
                headers: this.headers(),
                body: this.batchBody(events),
                signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
            });
        }
        catch {
            // Dropped: diagnostics never retry or surface errors.
        }
    }
    headers() {
        return {
            "content-type": "application/json",
            "x-client": this.opts.clientName,
            "x-client-version": this.opts.clientVersion,
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        };
    }
    track(sending) {
        this.inFlight.add(sending);
        void sending.finally(() => this.inFlight.delete(sending));
    }
    now() {
        return (this.opts.now ?? Date.now)();
    }
}
/**
 * Tee for the request log: every record still goes to `inner` unchanged, and a
 * few named numeric/enum fields of some records become diagnostics events.
 * Records are never copied: they can hold content (client.systemHead, URLs).
 */
export class DiagnosticsRequestSink {
    inner;
    diagnostics;
    onCreditBalanceTooLow;
    onClaudeAuth;
    onUpstreamOk;
    firstRequest = false;
    firstTurn = false;
    constructor(inner, diagnostics, 
    /** Anthropic refused for no credit (claude-auth.ts), with the request's sign-in type. */
    onCreditBalanceTooLow, 
    /** The sign-in type a request showed: subscription or api_key (claude-plan-warning.ts). */
    onClaudeAuth, 
    /** Anthropic answered a turn's request (2xx): a remembered credit refusal is stale. */
    onUpstreamOk) {
        this.inner = inner;
        this.diagnostics = diagnostics;
        this.onCreditBalanceTooLow = onCreditBalanceTooLow;
        this.onClaudeAuth = onClaudeAuth;
        this.onUpstreamOk = onUpstreamOk;
    }
    log(record) {
        this.inner?.log(record);
        try {
            this.observe(record);
        }
        catch {
            // Diagnostics never break the request log.
        }
    }
    observe(record) {
        if (record.kind === "messages")
            this.observeMessages(record);
        else if (record.kind === "memtree")
            this.observeMemtree(record);
    }
    observeMessages(rec) {
        if (rec.turnType === "foreign")
            return;
        const ccVersion = threePartVersion(rec.client?.ccVersion);
        if (ccVersion)
            this.diagnostics.setContext({ cc_version: ccVersion });
        // The request's own auth header beats the startup guess from config.
        if (rec.claudeAuth && rec.claudeAuth !== "unknown") {
            this.diagnostics.setContext({ claude_auth: rec.claudeAuth });
            this.onClaudeAuth?.(rec.claudeAuth);
        }
        if (rec.contextWindow) {
            this.diagnostics.setContext({ context_window_k: Math.round(rec.contextWindow / 1000) });
        }
        const fields = {
            status: rec.upstreamStatus, turn_type: turnType(rec.turnType), ttfb_ms: rec.ttfbMs,
            total_ms: rec.totalMs, request_kb: kb(rec.requestBytes),
        };
        if (!this.firstRequest) {
            this.firstRequest = true;
            this.diagnostics.record("first_request", fields);
        }
        if (!this.firstTurn && rec.client?.turnOrigin === "human") {
            this.firstTurn = true;
            this.diagnostics.record("first_turn", fields);
        }
        this.observeMessageErrors(rec, fields);
    }
    observeMessageErrors(rec, fields) {
        const status = rec.upstreamStatus;
        // Claude Code's own side requests (the security monitor) don't speak for its turns.
        if (typeof status === "number" && status >= 200 && status < 300 &&
            rec.turnType !== "side-request") {
            this.onUpstreamOk?.();
        }
        if (typeof status === "number" && status >= 400) {
            this.diagnostics.recordLimited(`upstream:${status}`, "upstream_error", fields);
        }
        if (rec.upstreamError === CREDIT_BALANCE_TOO_LOW) {
            this.diagnostics.recordLimited("credit", "error", { code: CREDIT_BALANCE_TOO_LOW });
            this.onCreditBalanceTooLow?.(rec.claudeAuth);
            // An API key's refusal; a subscription token's header (extra usage spent) stays one.
            if (rec.claudeAuth === undefined || rec.claudeAuth === "unknown") {
                this.onClaudeAuth?.("api_key");
            }
        }
        if (rec.compress?.timedOut) {
            this.diagnostics.recordLimited("compress_timeout", "compress_timeout", { ms: rec.compress.ms, request_kb: kb(rec.requestBytes) });
        }
    }
    observeMemtree(rec) {
        if (rec.ok)
            return;
        this.diagnostics.recordLimited(`memtree:${rec.status ?? "none"}`, "memtree_error", {
            status: rec.status, index_only: rec.indexOnly, ms: rec.ms, request_kb: kb(rec.requestBytes),
        });
    }
}
/** Record a launcher error by code only: Node's errno and class name, never its message. */
export function recordError(diagnostics, code, err) {
    const e = err;
    diagnostics.record("error", {
        code,
        errno: errnoName(e?.code),
        error_name: errorClassName(e?.name),
    });
}
/** The install id, created (0600) on first use; null when it cannot be read or written. */
export function readOrCreateInstallId(configDir) {
    const file = join(configDir, INSTALL_ID_FILE);
    try {
        const existing = readFileSync(file, "utf-8").trim();
        if (UUID_RE.test(existing))
            return { id: existing, created: false };
    }
    catch {
        // Missing: create it below.
    }
    try {
        mkdirSync(configDir, { recursive: true, mode: 0o700 });
        const id = randomUUID();
        writeFileSync(file, `${id}\n`, { mode: 0o600 });
        chmodSync(file, 0o600);
        return { id, created: true };
    }
    catch {
        return null;
    }
}
/** Environment context; every value is mapped onto an allowlisted shape. */
export function environmentContext(env, cccVersion) {
    return {
        ccc_version: threePartVersion(cccVersion),
        node: threePartVersion(process.versions.node),
        os: process.platform,
        os_release: /^\d{1,4}(?:\.\d{1,6}){0,2}/.exec(os.release())?.[0],
        arch: process.arch,
        terminal: terminalName(env),
        locale: localeName(),
        wsl: process.platform === "linux" && (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined),
    };
}
export function terminalName(env) {
    const raw = env.TERM_PROGRAM;
    if (!raw)
        return env.WT_SESSION ? "Windows_Terminal" : "none";
    const known = TERMINALS.find((t) => t.toLowerCase() === raw.toLowerCase());
    return known ?? "other";
}
export function localeName() {
    try {
        const locale = Intl.DateTimeFormat().resolvedOptions().locale;
        return /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/.test(locale) ? locale : "other";
    }
    catch {
        return "other";
    }
}
function turnType(value) {
    return TURN_TYPES.includes(value) ? value : "other";
}
function kb(bytes) {
    return typeof bytes === "number" ? Math.round(bytes / 1024) : undefined;
}
function envFlagSet(value) {
    return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}
//# sourceMappingURL=diagnostics.js.map