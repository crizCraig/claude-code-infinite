/**
 * Lets a session that ended past Claude Code's context limit be resumed.
 *
 * Claude Code sizes a resumed conversation from the usage recorded on the
 * transcript's last response. When that response was sent whole, near the
 * window (a tool loop that lost its compressed route), every later prompt is
 * refused locally ("Context limit reached") before ccc sees it, so ccc can
 * never compress the conversation: the session is stranded (2026-10-02).
 *
 * On `--resume <id>`, before Claude starts, ccc lowers that last response's
 * recorded usage to half the window, after backing up the transcript. Claude
 * Code then sends the next prompt, ccc compresses it as usual, and the next
 * response records the real size. Only the usage numbers of the last
 * response's entries change, and only for a shape ccc recognises; anything
 * else leaves the transcript untouched.
 */
import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "./config.js";
import { defaultProjectsDir, findTranscript } from "./transcript-usage.js";
import { contextLimitForModel } from "./turns.js";
/**
 * A recorded size within this fraction of the window is treated as stranded.
 * Claude Code refused at 979k of 1M; the margin is wide on purpose, since
 * lowering a session that still fit only lets Claude Code send a prompt ccc
 * compresses anyway.
 */
export const STRANDED_WINDOW_FRACTION = 0.9;
/** The lowered size, as a fraction of the window: room for the next prompt. */
export const LOWERED_WINDOW_FRACTION = 0.5;
/** Lowers a stranded resumed session's recorded usage; undefined when nothing changed. */
export function repairStrandedResume(claudeArgs, options) {
    const sessionId = resumeSessionId(claudeArgs);
    if (sessionId === undefined)
        return undefined;
    const file = findTranscript(options.projectsDir ?? defaultProjectsDir(), sessionId);
    if (file === undefined)
        return undefined;
    const text = fs.readFileSync(file, "utf-8");
    const lines = text.split("\n");
    const plan = planUsageRepair(lines, options.nativeOneMillionContext);
    if (plan === undefined)
        return undefined;
    const backupPath = backupTranscript(file, sessionId, options);
    for (const index of plan.lineIndexes)
        lines[index] = lowerUsage(lines[index], plan.loweredTokens);
    writeAtomically(file, lines.join("\n"));
    return {
        sessionId,
        recordedTokens: plan.recordedTokens,
        loweredTokens: plan.loweredTokens,
        backupPath,
    };
}
/** The session id of `--resume <id>`, `--resume=<id>` or `-r <id>`; not the picker form. */
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
/** The last response's entries and sizes, when its recorded usage strands the session. */
export function planUsageRepair(lines, nativeOneMillionContext) {
    const last = lastResponse(lines);
    if (last === undefined)
        return undefined;
    const window = contextLimitForModel(last.model, undefined, nativeOneMillionContext);
    if (last.recordedTokens < window * STRANDED_WINDOW_FRACTION)
        return undefined;
    return {
        lineIndexes: entriesOfResponse(lines, last.messageId),
        recordedTokens: last.recordedTokens,
        loweredTokens: Math.floor(window * LOWERED_WINDOW_FRACTION),
    };
}
/** The newest real (non-synthetic) assistant response with usage ccc recognises. */
function lastResponse(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
        const message = assistantMessage(lines[i]);
        if (message === undefined || message.model === "<synthetic>")
            continue;
        const recordedTokens = recordedSize(message.usage);
        if (recordedTokens === undefined)
            return undefined;
        return { messageId: message.id, model: message.model, recordedTokens };
    }
    return undefined;
}
function entriesOfResponse(lines, messageId) {
    const indexes = [];
    lines.forEach((line, index) => {
        if (assistantMessage(line)?.id === messageId)
            indexes.push(index);
    });
    return indexes;
}
function assistantMessage(line) {
    if (!line.includes('"assistant"'))
        return undefined;
    let entry;
    try {
        entry = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    const message = entry?.type === "assistant" ? entry.message : undefined;
    if (typeof message?.id !== "string" || typeof message.model !== "string")
        return undefined;
    if (!message.usage || typeof message.usage !== "object")
        return undefined;
    return message;
}
/** What Claude Code counts as the context: every input bucket plus the output. */
function recordedSize(usage) {
    const keys = [
        "input_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
        "output_tokens",
    ];
    let total = 0;
    for (const key of keys) {
        const value = usage[key] ?? 0;
        if (typeof value !== "number" || !Number.isFinite(value))
            return undefined;
        total += value;
    }
    return total;
}
/** Moves the whole recorded input into input_tokens at the lowered size. */
function lowerUsage(line, loweredTokens) {
    const entry = JSON.parse(line);
    const usage = entry.message.usage;
    usage.input_tokens = loweredTokens;
    usage.cache_read_input_tokens = 0;
    usage.cache_creation_input_tokens = 0;
    if (usage.cache_creation && typeof usage.cache_creation === "object") {
        for (const key of Object.keys(usage.cache_creation)) {
            if (typeof usage.cache_creation[key] === "number")
                usage.cache_creation[key] = 0;
        }
    }
    return JSON.stringify(entry);
}
function backupTranscript(file, sessionId, options) {
    const dir = options.backupDir ?? path.join(getConfigDir(), "transcript-backups");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(dir, `${sessionId}.${stamp}.jsonl`);
    fs.copyFileSync(file, backupPath);
    return backupPath;
}
function writeAtomically(file, text) {
    const temp = `${file}.ccc-${process.pid}.tmp`;
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, file);
}
/** Session ids name files (transcript-usage's SAFE_ID); a leading dash is the next flag. */
function validId(value) {
    return value !== undefined && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value) ? value : undefined;
}
//# sourceMappingURL=resume-repair.js.map