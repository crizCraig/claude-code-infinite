import { approxTokensFromBytes } from "./reqlog.js";
/** Bound on a count call: past it the caller keeps its estimate. */
export const COUNT_TOKENS_TIMEOUT_MS = 3_000;
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
const COUNTABLE_FIELDS = ["model", "messages", "system", "tools", "tool_choice", "thinking"];
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
/**
 * Count `body`'s input tokens upstream with the caller's headers (credentials,
 * anthropic-version, betas). Never rejects: any failure or a timeout resolves
 * without `tokens`, and the caller keeps its estimate.
 */
export function countUpstreamTokens(args) {
    const started = Date.now();
    const payload = countTokensBody(args.body);
    if (!payload || args.signal?.aborted)
        return Promise.resolve({ ms: 0 });
    return new Promise((resolve) => {
        let done = false;
        const finish = (result) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            args.signal?.removeEventListener("abort", abort);
            resolve({ ...result, ms: Date.now() - started });
        };
        const request = args.upstream.module.request({
            host: args.upstream.host,
            port: args.upstream.port,
            method: "POST",
            path: countTokensPath(args.requestUrl),
            headers: countTokensHeaders(args.headers, payload.length),
        }, (res) => readCount(res, (tokens) => finish({ tokens, status: res.statusCode })));
        const abort = () => { request.destroy(); finish({}); };
        const timer = setTimeout(abort, args.timeoutMs ?? COUNT_TOKENS_TIMEOUT_MS);
        args.signal?.addEventListener("abort", abort, { once: true });
        request.on("error", () => finish({}));
        request.end(payload);
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
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("error", () => done());
    res.on("end", () => {
        if (res.statusCode !== 200)
            return done();
        try {
            const tokens = JSON.parse(Buffer.concat(chunks).toString("utf-8"))?.input_tokens;
            done(typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined);
        }
        catch {
            done();
        }
    });
}
//# sourceMappingURL=count-tokens.js.map