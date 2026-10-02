/**
 * Repair only a demonstrably stranded resume, before Claude starts. Unknown
 * shapes, concurrent writers and filesystem errors leave the resume unchanged.
 * Only the final response's totals and Claude's counted iteration are lowered.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getConfigDir } from "./config.js";
import { defaultProjectsDir, findTranscript } from "./transcript-usage.js";
import { contextLimitForModel } from "./turns.js";
import { replaceQuiescentTranscript, transcriptIsQuiescent } from "./resume-repair-file.js";
/** Unknown versions use the full window: never the former speculative 90%. */
export const STRANDED_WINDOW_FRACTION = 1;
export const LOWERED_WINDOW_FRACTION = 0.5;
export function repairStrandedResume(claudeArgs, options) {
    try {
        const sessionId = resumeSessionId(claudeArgs);
        if (!sessionId)
            return undefined;
        const file = findTranscript(options.projectsDir ?? defaultProjectsDir(), sessionId);
        if (!file)
            return undefined;
        const quiescent = options.isQuiescent ?? transcriptIsQuiescent;
        if (!quiescent(file) || !fs.lstatSync(file).isFile())
            return undefined;
        const snapshot = fs.statSync(file, { bigint: true });
        const original = fs.readFileSync(file);
        const lines = original.toString("utf8").split("\n");
        if (!Buffer.from(lines.join("\n"), "utf8").equals(original))
            return undefined;
        const plan = planUsageRepair(lines, options.nativeOneMillionContext, options.claudeVersion ?? installedVersion());
        if (!plan)
            return undefined;
        for (const index of plan.lineIndexes)
            lines[index] = lowerUsage(lines[index], plan.loweredTokens);
        const backupPath = replaceQuiescentTranscript({
            file, original, snapshot, replacement: lines.join("\n"), quiescent,
            backupDir: options.backupDir ?? path.join(getConfigDir(), "transcript-backups"),
            sessionId, now: options.now,
        });
        return backupPath ? { sessionId, recordedTokens: plan.recordedTokens,
            loweredTokens: plan.loweredTokens, backupPath } : undefined;
    }
    catch {
        // Repair is optional: no error may prevent launching the original resume.
        return undefined;
    }
}
export function resumeSessionId(args) {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--")
            return undefined;
        if (arg.startsWith("--resume="))
            return validId(arg.slice("--resume=".length));
        if (arg === "--resume" || arg === "-r")
            return validId(args[i + 1]);
    }
    return undefined;
}
export function planUsageRepair(lines, nativeOneMillionContext, claudeVersion = "unknown") {
    try {
        const entries = lines.map(line => line.trim() ? JSON.parse(line) : undefined);
        if (entries.some(e => e !== undefined && !record(e)))
            return undefined;
        const last = entries.findLast(e => e?.type === "assistant" && e?.message?.model !== "<synthetic>");
        const message = last?.message;
        if (!knownMessage(message))
            return undefined;
        const window = contextLimitForModel(message.model, undefined, nativeOneMillionContext);
        // 2.1.288's ode/RPe -> kvt: contextWindow - min(maxOutputTokens, 20000) - 3000.
        // These supported model families all have >=20k output capacity. Overrides
        // make the threshold uncertain, so automatic repair is skipped entirely.
        if (process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE !== undefined ||
            process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS !== undefined)
            return undefined;
        const threshold = claudeVersion === "2.1.288" ? window - 23_000 : window;
        const recordedTokens = recordedSize(message.usage);
        const loweredTokens = Math.floor(window * LOWERED_WINDOW_FRACTION);
        if (recordedTokens === undefined || recordedTokens < threshold)
            return undefined;
        const lineIndexes = [];
        for (let i = 0; i < entries.length; i++) {
            const m = entries[i]?.type === "assistant" ? entries[i].message : undefined;
            if (m?.id !== message.id)
                continue;
            if (!knownMessage(m) || m.model !== message.model ||
                recordedSize(m.usage) !== recordedTokens ||
                loweredTokens + countedUsage(m.usage).output_tokens >= threshold)
                return undefined;
            lineIndexes.push(i);
        }
        return { lineIndexes, recordedTokens, loweredTokens };
    }
    catch {
        return undefined;
    }
}
const BUCKETS = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"];
const KINDS = new Set(["message", "fallback_message", "advisor_message", "compaction"]);
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function knownMessage(message) {
    return record(message) && typeof message.id === "string" && message.id.length > 0 &&
        typeof message.model === "string" &&
        /^claude-(?:opus-(?:4-[56]|5-5)|sonnet-4-[56])(?:-\d{8})?(?:\[1m\])?$/.test(message.model) &&
        validUsage(message.usage);
}
function validBuckets(value) {
    return record(value) && BUCKETS.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) &&
        (value.cache_creation === undefined || (record(value.cache_creation) &&
            Object.values(value.cache_creation).every(n => Number.isSafeInteger(n) && n >= 0)));
}
function validUsage(usage) {
    if (!validBuckets(usage))
        return false;
    if (usage.iterations === undefined)
        return true;
    return Array.isArray(usage.iterations) && usage.iterations.length > 0 &&
        usage.iterations.every((it) => validBuckets(it) && KINDS.has(it.type)) &&
        usage.iterations.some((it) => it.type === "message" || it.type === "fallback_message");
}
function countedUsage(usage) {
    return usage.iterations?.findLast((it) => it.type !== "advisor_message" && it.type !== "compaction") ?? usage;
}
function recordedSize(usage) {
    if (!validUsage(usage))
        return undefined;
    const counted = countedUsage(usage);
    const total = BUCKETS.reduce((n, key) => n + counted[key], 0);
    return Number.isSafeInteger(total) ? total : undefined;
}
function lowerUsage(line, loweredTokens) {
    const entry = JSON.parse(line);
    const usage = entry.message.usage;
    const counted = countedUsage(usage);
    lowerBuckets(usage, loweredTokens);
    if (counted !== usage)
        lowerBuckets(counted, loweredTokens);
    return JSON.stringify(entry);
}
function lowerBuckets(usage, loweredTokens) {
    usage.input_tokens = loweredTokens;
    usage.cache_read_input_tokens = 0;
    usage.cache_creation_input_tokens = 0;
    if (usage.cache_creation) {
        for (const key of Object.keys(usage.cache_creation))
            usage.cache_creation[key] = 0;
    }
}
function installedVersion() {
    try {
        return execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 1500,
            stdio: ["ignore", "pipe", "ignore"] }).match(/^(\d+\.\d+\.\d+)\b/)?.[1] ?? "unknown";
    }
    catch {
        return "unknown";
    }
}
function validId(value) {
    return value !== undefined && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value) ? value : undefined;
}
//# sourceMappingURL=resume-repair.js.map