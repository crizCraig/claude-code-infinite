/**
 * Exact input-token counts from Anthropic's Count Tokens endpoint, made with
 * the user's own credentials, for the size estimates that decide compaction
 * and the fallback refusal (route-fallback.ts).
 *
 * The proxy normally sizes a request from an earlier response's reported
 * usage (a tokens-per-byte sample). That sample can be missing (a fresh proxy
 * after a resume), stale (a big jump of new content of unknown density), or
 * wrong for the request at hand: on 2026-10-05 a 979-byte web-search helper
 * reported 12,040 input tokens (server-side search results count as input),
 * and the 12 tokens/byte it taught its lane sized the next 169,507-byte
 * subagent request at 2.08M tokens and refused it. Counting is free but costs
 * a round trip that re-uploads the body, so it runs only where the estimate
 * is unknown or decides the outcome, never on every request.
 */
import { createHash } from "node:crypto";
import https from "node:https";
import { approxTokensFromBytes } from "./reqlog.js";
/** Bound on a count call: past it the caller keeps its estimate. */
export const COUNT_TOKENS_TIMEOUT_MS = 3_000;
const MAX_COUNT_RESPONSE_BYTES = 64 * 1024;
const MAX_COUNT_COOLDOWNS = 128;
const COUNT_COOLDOWN_MS = 60_000;
/**
 * Plausible tokens per byte for a sample. Text runs ~0.25-0.5. Above 1 the
 * sample measured something other than the body (server tool results), as on
 * 2026-10-05 (12 tokens/byte). The floor is loose on purpose: base64 images
 * are very cheap per byte (a ~1.5MB screenshot is ~1.6k tokens), so a
 * screenshot-heavy session can sit well under 0.1 and must stay calibrated
 * rather than be counted on every request.
 */
export const MIN_PLAUSIBLE_TOKENS_PER_BYTE = 0.02;
export const MAX_PLAUSIBLE_TOKENS_PER_BYTE = 1;
/** With no usable sample, count once bytes/4 reaches this share of the budget. */
const UNCALIBRATED_COUNT_SHARE = 0.4;
/** With a sample, count a jump of new content once the estimate nears the budget. */
const NEAR_BUDGET_SHARE = 0.85;
/** Growth since the sample (bytes/4) that counts as a jump, as a share of the budget. */
const JUMP_BUDGET_SHARE = 0.05;
/** Request fields Count Tokens accepts; others (max_tokens, stream, ...) it rejects. */
const COUNTABLE_FIELDS = [
    "model", "messages", "system", "tools", "tool_choice", "thinking",
    "context_management", "output_config", "output_format", "cache_control",
    "mcp_servers", "speed", "compaction",
];
/** Whether a sample's tokens-per-byte ratio can describe a request body. */
export function plausibleSample(sample) {
    if (!sample || !(sample.tokens > 0) || !(sample.forwardedBytes > 0))
        return false;
    const ratio = sample.tokens / sample.forwardedBytes;
    return ratio >= MIN_PLAUSIBLE_TOKENS_PER_BYTE && ratio <= MAX_PLAUSIBLE_TOKENS_PER_BYTE;
}
/**
 * Whether to count a request of `bytes` before deciding on it: with no usable
 * sample once its estimate is a real share of the budget, and with one only
 * after a jump of new content brings it near the budget. Small growth on a
 * calibrated sample is estimated well and is not counted.
 */
export function shouldCountTokens(sample, bytes, estimateTokens, budgetTokens) {
    if (!(budgetTokens > 0))
        return false;
    if (!plausibleSample(sample))
        return estimateTokens >= UNCALIBRATED_COUNT_SHARE * budgetTokens;
    if (bytes <= sample.forwardedBytes)
        return false;
    const addedTokens = approxTokensFromBytes(bytes - sample.forwardedBytes);
    return addedTokens >= JUMP_BUDGET_SHARE * budgetTokens &&
        estimateTokens >= NEAR_BUDGET_SHARE * budgetTokens;
}
/** Shared per proxy; only hashes of account/upstream identity are stored. */
export class CountTokensCooldowns {
    capacity;
    now;
    entries = new Map();
    constructor(capacity = MAX_COUNT_COOLDOWNS, now = Date.now) {
        this.capacity = capacity;
        this.now = now;
    }
    active(key) {
        const until = this.entries.get(key);
        if (until === undefined)
            return false;
        if (until > this.now())
            return true;
        this.entries.delete(key);
        return false;
    }
    record(key, result) {
        if (![401, 403, 429].includes(result.status ?? 0))
            return;
        const now = this.now();
        for (const [entry, until] of this.entries)
            if (until <= now)
                this.entries.delete(entry);
        this.entries.delete(key);
        if (this.capacity <= 0)
            return;
        while (this.entries.size >= this.capacity)
            this.entries.delete(this.entries.keys().next().value);
        this.entries.set(key, now + cooldownDuration(result.retryAfter, now));
    }
}
/** Exact results belong to this request and body, never a shared sample slot. */
export function createCountTokensSession(options, cooldowns = new CountTokensCooldowns()) {
    const pending = new Map();
    const completed = new Map();
    const account = countAccountKey(options);
    let deadline;
    return {
        peek: (body) => completed.get(bodyHash(body)),
        count: (body) => {
            const key = bodyHash(body);
            const existing = pending.get(key);
            if (existing)
                return existing;
            deadline ??= Date.now() + (options.timeoutMs ?? COUNT_TOKENS_TIMEOUT_MS);
            const remaining = deadline - Date.now();
            const skipped = options.signal?.aborted ? "aborted"
                : cooldowns.active(account) ? "cooldown" : remaining <= 0 ? "deadline" : undefined;
            const attempt = skipped
                ? Promise.resolve({ ms: 0, outcome: skipped })
                : countUpstreamTokens({ ...options, body, timeoutMs: remaining }).then((result) => {
                    cooldowns.record(account, result);
                    if (result.outcome !== "invalid-request" && result.outcome !== "deadline") {
                        try {
                            options.onAttempt?.(result);
                        }
                        catch { /* diagnostics cannot break forwarding */ }
                    }
                    return result;
                });
            const saved = attempt.then((result) => { completed.set(key, result); return result; });
            pending.set(key, saved);
            return saved;
        },
    };
}
/** All failures resolve without tokens, including synchronous request errors. */
export function countUpstreamTokens(args) {
    const started = Date.now();
    const payload = countTokensBody(args.body);
    if (!payload || args.signal?.aborted)
        return Promise.resolve({
            ms: 0, outcome: args.signal?.aborted ? "aborted" : "invalid-request",
        });
    const remaining = (args.timeoutMs ?? COUNT_TOKENS_TIMEOUT_MS) - (Date.now() - started);
    if (remaining <= 0)
        return Promise.resolve({ ms: Date.now() - started, outcome: "deadline" });
    return new Promise((resolve) => {
        let done = false;
        let request;
        let timer;
        const finish = (result) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            args.signal?.removeEventListener("abort", abort);
            resolve({ ...result, ms: Date.now() - started });
            request?.destroy();
        };
        const abort = () => finish({ outcome: "aborted" });
        timer = setTimeout(() => finish({ outcome: "timeout" }), remaining);
        args.signal?.addEventListener("abort", abort, { once: true });
        try {
            request = args.upstream.module.request({
                host: args.upstream.host,
                port: args.upstream.port,
                method: "POST",
                path: countTokensPath(args.requestUrl),
                headers: countTokensHeaders(args.headers, payload.length),
            }, (res) => readCount(res, finish));
            request.on("error", () => finish({ outcome: "network-error" }));
            if (args.signal?.aborted)
                abort();
            else
                request.end(payload);
        }
        catch {
            finish({ outcome: "network-error" });
        }
    });
}
/** The countable subset of a Messages request body, or null if it is not one. */
export function countTokensBody(body) {
    try {
        const parsed = JSON.parse(body.toString("utf-8"));
        if (!parsed || !Array.isArray(parsed.messages))
            return null;
        const countable = {};
        for (const field of COUNTABLE_FIELDS) {
            if (parsed[field] !== undefined)
                countable[field] = parsed[field];
        }
        return Buffer.from(JSON.stringify(countable), "utf-8");
    }
    catch {
        return null;
    }
}
/** The Messages request's path with `/count_tokens` appended, query kept. */
export function countTokensPath(requestUrl) {
    const url = new URL(requestUrl ?? "/v1/messages", "http://127.0.0.1");
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/count_tokens`;
    return `${url.pathname}${url.search}`;
}
function countTokensHeaders(headers, length) {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        const lower = key.toLowerCase();
        if (lower === "content-length" || lower === "accept-encoding")
            continue;
        out[key] = value;
    }
    out["content-length"] = String(length);
    out["content-type"] = "application/json";
    out["accept-encoding"] = "identity";
    return out;
}
function readCount(res, done) {
    const status = res.statusCode;
    res.on("error", () => done({ outcome: "network-error", status }));
    res.on("aborted", () => done({ outcome: "network-error", status }));
    if (status !== 200) {
        const outcome = status === 401 || status === 403 ? "auth"
            : status === 429 ? "rate-limit" : status !== undefined && status >= 500
                ? "server-error" : "http-error";
        done({ outcome, status, retryAfter: res.headers["retry-after"] });
        res.destroy();
        return;
    }
    const chunks = [];
    let bytes = 0;
    res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_COUNT_RESPONSE_BYTES) {
            done({ outcome: "invalid-response", status });
            res.destroy();
        }
        else
            chunks.push(chunk);
    });
    res.on("end", () => {
        try {
            const tokens = JSON.parse(Buffer.concat(chunks).toString("utf-8"))?.input_tokens;
            if (typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0) {
                done({ tokens, outcome: "success", status });
            }
            else
                done({ outcome: "invalid-response", status });
        }
        catch {
            done({ outcome: "invalid-response", status });
        }
    });
}
function bodyHash(body) {
    return createHash("sha256").update(body).digest("hex");
}
function countAccountKey(options) {
    const credentials = Object.entries(options.headers)
        .filter(([key]) => ["authorization", "x-api-key"].includes(key.toLowerCase()))
        .map(([key, value]) => [key.toLowerCase(), value]).sort();
    return bodyHash(Buffer.from(JSON.stringify([
        options.upstream.module.globalAgent === https.globalAgent ? "https" : "http", options.upstream.host,
        options.upstream.port, credentials,
    ])));
}
function cooldownDuration(retryAfter, now) {
    if (!retryAfter)
        return COUNT_COOLDOWN_MS;
    const seconds = Number(retryAfter);
    const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
    return Number.isFinite(duration)
        ? Math.max(1000, Math.min(COUNT_COOLDOWN_MS, duration)) : COUNT_COOLDOWN_MS;
}
//# sourceMappingURL=count-tokens.js.map