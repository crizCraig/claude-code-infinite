/**
 * Always-on request/timing log (append-only JSONL) for post-hoc incident
 * reconstruction — when a turn stalls for minutes we want a client-side
 * record without asking the user to relaunch with --debug.
 *
 * Hard constraints:
 * - NEVER throw and NEVER block the proxy path: every filesystem touch is
 *   wrapped in try/catch and writes are fire-and-forget (async appendFile
 *   with an ignored error callback). A broken log path degrades to silence.
 * - Append-only single file at ~/.claude-code-infinite/logs/requests.jsonl,
 *   with one rotation slot: if the file exceeds ~20MB at proxy startup it is
 *   renamed to requests.jsonl.1 (overwriting any previous .1).
 *
 * One JSON object per line. `ts` (ISO 8601) and `pid` (the ccc process, which
 * tells apart concurrent ccc sessions sharing this file) are stamped here so
 * callers only supply event fields. Token counts under `approxInputTokens` are a rough
 * proxy (text bytes/4, images by their dimensions), NOT real tokenizer output — exact usage, when
 * the response format lets us extract it cheaply, lands under `usage`.
 */
import { appendFile, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "./config.js";
const MAX_LOG_BYTES = 20 * 1024 * 1024; // rotate above ~20MB at startup
const APPROX_CHARS_PER_TOKEN = 4;
/** Rough bytes→tokens estimate (bytes/4). Label the result approximate. */
export function approxTokensFromBytes(bytes) {
    return Math.round(bytes / APPROX_CHARS_PER_TOKEN);
}
export function defaultLogPath() {
    return join(getConfigDir(), "logs", "requests.jsonl");
}
export class RequestLogger {
    path;
    pendingWrites = new Set();
    constructor(filePath) {
        this.path = filePath ?? defaultLogPath();
        try {
            mkdirSync(dirname(this.path), { recursive: true });
            rotateIfLarge(this.path);
        }
        catch {
            // Unwritable/odd log location: run silent, never break startup.
        }
    }
    /** Fire-and-forget append of one JSONL line. Never throws, never blocks. */
    log(record) {
        try {
            const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...record }) + "\n";
            let finish;
            const pending = new Promise((resolve) => {
                finish = resolve;
            });
            const settle = () => {
                this.pendingWrites.delete(pending);
                finish();
            };
            this.pendingWrites.add(pending);
            try {
                appendFile(this.path, line, settle);
            }
            catch {
                settle();
            }
        }
        catch {
            // Serialization/scheduling failure — same policy.
        }
    }
    /**
     * Shutdown-only durability seam. Wait for already-scheduled appends without
     * making normal proxy logging synchronous; false means the bounded wait
     * expired. Callers should stop request producers before invoking this.
     */
    async flush(timeoutMs = 2_000) {
        const boundedMs = Number.isFinite(timeoutMs) && timeoutMs >= 0
            ? Math.floor(timeoutMs)
            : 2_000;
        const deadline = Date.now() + boundedMs;
        while (this.pendingWrites.size > 0) {
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                return false;
            let timer;
            const completed = await Promise.race([
                Promise.allSettled([...this.pendingWrites]).then(() => true),
                new Promise((resolve) => {
                    timer = setTimeout(() => resolve(false), remaining);
                }),
            ]);
            if (timer)
                clearTimeout(timer);
            if (!completed)
                return false;
        }
        return true;
    }
}
const savingsUsageProtocols = new WeakMap();
export function mergeUsageFromSseEvent(data, rec) {
    const type = data?.type;
    let protocol = savingsUsageProtocols.get(rec);
    if (!protocol) {
        protocol = { started: false, finalOutput: false, invalid: false };
        savingsUsageProtocols.set(rec, protocol);
    }
    if (type === "message_start") {
        if (rec.savingsUsageComplete !== undefined)
            rec.savingsUsageComplete = false;
        const usage = data?.message?.usage;
        protocol.invalid ||= protocol.started || !validSavingsUsage(usage, true);
        protocol.started = true;
        mergeUsage(usage, rec);
    }
    else if (type === "message_delta") {
        if (rec.savingsUsageComplete !== undefined)
            rec.savingsUsageComplete = false;
        const usage = data?.usage;
        protocol.invalid ||= !protocol.started || !validSavingsUsage(usage, false);
        protocol.finalOutput = validTokenCount(usage?.output_tokens);
        mergeUsage(usage, rec);
    }
    else if (type === "error") {
        protocol.invalid = true;
        rec.savingsUsageComplete = false;
    }
    else if (type === "message_stop") {
        rec.savingsUsageComplete = protocol.started && protocol.finalOutput && !protocol.invalid;
    }
}
/** Merge usage from a non-streaming /v1/messages JSON response body. */
export function mergeUsageFromJsonBody(body, rec) {
    rec.savingsUsageComplete = false;
    try {
        const response = JSON.parse(body.toString("utf-8"));
        mergeUsage(response?.usage, rec);
        rec.savingsUsageComplete = response?.type === "message" && Array.isArray(response.content) &&
            validSavingsUsage(response.usage, true);
    }
    catch {
        // Not the shape we expected — usage just stays absent.
    }
}
const validTokenCount = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** Validate the raw fields before reqlog's permissive merge can drop bad values.
 * In particular an invalid final output must not leave the valid initial zero
 * looking like the complete billable output count. */
function validSavingsUsage(value, full) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const usage = value;
    if (full && (!validTokenCount(usage.input_tokens) || !validTokenCount(usage.output_tokens)))
        return false;
    for (const field of USAGE_FIELDS) {
        if (Object.hasOwn(usage, field) && !validTokenCount(usage[field]))
            return false;
    }
    if (Object.hasOwn(usage, "cache_creation")) {
        const creation = usage.cache_creation;
        if (!creation || typeof creation !== "object" || Array.isArray(creation))
            return false;
        for (const field of ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"]) {
            if (Object.hasOwn(creation, field) && !validTokenCount(creation[field]))
                return false;
        }
    }
    return true;
}
const USAGE_FIELDS = [
    "input_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
];
function mergeUsage(usage, rec) {
    if (!usage || typeof usage !== "object")
        return;
    for (const field of USAGE_FIELDS) {
        const value = usage[field];
        if (typeof value !== "number")
            continue;
        rec.usage = rec.usage ?? {};
        rec.usage[field] = value;
    }
    const speed = usage.speed;
    if (speed === "fast" || speed === "standard")
        (rec.usage ??= {}).speed = speed;
    const creation = usage.cache_creation;
    if (creation && typeof creation === "object") {
        const target = ((rec.usage ??= {}).cache_creation ??= {});
        for (const key of ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"]) {
            const value = creation[key];
            if (typeof value === "number")
                target[key] = value;
        }
    }
    const serverTools = serverToolUse(usage.server_tool_use);
    if (serverTools)
        (rec.usage ??= {}).server_tool_use = serverTools;
}
/** The numeric counts of a usage `server_tool_use` object, if it has any. */
function serverToolUse(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const counts = Object.entries(value)
        .filter((entry) => typeof entry[1] === "number");
    return counts.length ? Object.fromEntries(counts) : undefined;
}
/** Startup size protection: one rotation slot, old .1 is overwritten. */
function rotateIfLarge(path) {
    try {
        if (statSync(path).size > MAX_LOG_BYTES)
            renameSync(path, `${path}.1`);
    }
    catch {
        // Missing file (fresh install) or unreadable — nothing to rotate.
    }
}
//# sourceMappingURL=reqlog.js.map