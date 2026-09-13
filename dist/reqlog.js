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
 * One JSON object per line. `ts` (ISO 8601) is stamped here so callers only
 * supply event fields. Token counts under `approxInputTokens` are a rough
 * bytes/4 chars→tokens proxy, NOT real tokenizer output — exact usage, when
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
            const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
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
/**
 * Merge token usage out of a parsed SSE event into a record. Anthropic sends
 * input/cache counts on message_start and the final output count (plus
 * occasionally refreshed input counts) on message_delta.
 */
export function mergeUsageFromSseEvent(data, rec) {
    const type = data?.type;
    if (type === "message_start")
        mergeUsage(data?.message?.usage, rec);
    else if (type === "message_delta")
        mergeUsage(data?.usage, rec);
}
/** Merge usage from a non-streaming /v1/messages JSON response body. */
export function mergeUsageFromJsonBody(body, rec) {
    try {
        mergeUsage(JSON.parse(body.toString("utf-8"))?.usage, rec);
    }
    catch {
        // Not the shape we expected — usage just stays absent.
    }
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