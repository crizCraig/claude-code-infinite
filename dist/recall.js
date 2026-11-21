/** Display-only recall. Claude Code passes the same tool-use ID to MCP and
 * PostToolUse. A private receipt joins them without changing the tool result
 * (even a large result that Claude Code spills to disk before the hook). */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "./config.js";
import { timeSpan } from "./memtree-times.js";
export const RECALL_ACTIVE = "CCC_RECALL_HOOKS_ACTIVE";
export const RECALL_WRAPPED = "CCC_RECALL_WRAPPED";
export const RECALL_MATCHER = "^mcp__memtree__(search|read_node|read_lines)$";
const collecting = new AsyncLocalStorage();
/** Optional provenance extraction must never turn a successful tool into an error,
 * even on an old or partially malformed server response. */
export function collectRecalls(record) {
    if (!collecting.getStore())
        return;
    try {
        record();
    }
    catch { /* The normal formatter owns the tool result. */ }
}
const receiptsDir = () => path.join(getConfigDir(), "recall-notices");
const matcher = new RegExp(RECALL_MATCHER);
function key(...ids) {
    return createHash("sha256").update(JSON.stringify(ids)).digest("hex");
}
let lastPruned = 0;
function privateDir() {
    const dir = receiptsDir();
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
    // A cancelled tool or killed client may never run its matching hook.
    if (Date.now() - lastPruned > 3600000) {
        lastPruned = Date.now();
        for (const name of fs.readdirSync(dir)) {
            if (!/^[a-f0-9]{64}(\.[a-f0-9]{64})?$/.test(name))
                continue;
            const file = path.join(dir, name);
            try {
                if (Date.now() - fs.lstatSync(file).mtimeMs > 86400000)
                    fs.rmSync(file, { recursive: true, force: true });
            }
            catch { /* Claimed by a concurrent hook. */ }
        }
    }
    return dir;
}
export async function withRecallReceipt(tool, id, answer) {
    if (process.env[RECALL_ACTIVE] !== "1" || process.env.CCC_RECALL_NOTICE === "0" ||
        typeof id !== "string" || !id || !matcher.test("mcp__memtree__" + tool))
        return answer();
    const passages = [];
    const text = await collecting.run(passages, answer);
    if (passages.length) {
        try {
            fs.writeFileSync(path.join(privateDir(), key(tool, id)), JSON.stringify(passages), { mode: 0o600, flag: "wx" });
        }
        catch { /* Optional UI must never change the result. */ }
    }
    return text;
}
function shortLabel(value) {
    if (typeof value !== "string")
        return "";
    const clean = stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
    const chars = Array.from(clean);
    return chars.length > 60 ? chars.slice(0, 59).join("") + "…" : clean;
}
function digest(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
function fingerprint(bytes) {
    return { size: bytes.length, anchor: bytes.subarray(0, 4).toString("hex"), digest: digest(bytes) };
}
function sourceProbes(excerpts) {
    const probes = [];
    for (const excerpt of excerpts) {
        // Select literals that survive both JSON encoding and flattening tool blocks.
        const parts = excerpt.slice(0, 4096).match(/[^"\\\p{Cc}]+/gu);
        const sample = parts?.reduce((longest, part) => part.length > longest.length ? part : longest, "").trim();
        if (!sample)
            continue;
        const bytes = Buffer.from(sample);
        const size = Math.min(32, bytes.length);
        for (const start of new Set([0, Math.floor((bytes.length - size) / 2), bytes.length - size])) {
            probes.push(fingerprint(bytes.subarray(start, start + size)));
        }
        if (probes.length >= 9)
            break;
    }
    return probes;
}
export function recallPassage(session, summary, at, excerpts, sourceTime) {
    const passages = collecting.getStore();
    if (!passages || typeof session !== "string" || !session || session.length > 128)
        return;
    const label = shortLabel(summary);
    const probes = sourceProbes(excerpts);
    const sourceAt = !probes.length ? timeSpan([sourceTime, sourceTime])?.[0] : undefined;
    if (label && !probes.length)
        probes.push(...sourceProbes([label]));
    if (!label && !probes.length)
        return;
    const date = timeSpan([at, at])?.[0];
    passages.push({ session, label, ...(date ? { at: date } : {}), sourceAt, probes });
}
/** Search the delivered bytes only when a tool returns this session's history.
 * indexOf skips straight to the four-byte anchors in native code; confirm
 * the complete sample with its digest before attributing the passage. */
function present(body, probe) {
    const anchor = Buffer.from(probe.anchor, "hex");
    if (!anchor.length || probe.size < anchor.length || probe.size > 32)
        return false;
    let candidates = 0;
    for (let i = body.indexOf(anchor); i !== -1; i = body.indexOf(anchor, i + 1)) {
        // Repetitive inputs (e.g. base64 padding) must not stall the proxy.
        if (++candidates > 1024)
            return undefined;
        if (digest(body.subarray(i, i + probe.size)) === probe.digest)
            return true;
    }
    return false;
}
export function recalled(input, context) {
    if (process.env.CCC_RECALL_NOTICE === "0" || input?.hook_event_name !== "PostToolUse" ||
        !input.tool_name || !matcher.test(input.tool_name) || typeof input.tool_use_id !== "string")
        return;
    let raw;
    try {
        const file = path.join(receiptsDir(), key(input.tool_name.slice("mcp__memtree__".length), input.tool_use_id));
        raw = JSON.parse(fs.readFileSync(file, "utf8"));
        fs.unlinkSync(file);
    }
    catch {
        return;
    }
    if (!Array.isArray(raw) || !input.session_id || !input.prompt_id)
        return;
    const items = raw.filter(p => typeof p?.session === "string" && p.session && Array.isArray(p.probes));
    const missing = new Map();
    function compressedOut(probe) {
        if (!context)
            return false;
        let absent = missing.get(probe.digest);
        if (absent === undefined) {
            absent = present(context.sent, probe) === false && present(context.original, probe) === true;
            missing.set(probe.digest, absent);
        }
        return absent;
    }
    let batch;
    for (const p of items) {
        const past = p.session !== input.session_id;
        if (!past && !p.probes.some(compressedOut)) {
            if (!p.sourceAt || !context?.sourceAt || !sourceProbes(context.sourceAt(p.sourceAt)).some(compressedOut))
                continue;
        }
        batch ??= { label: shortLabel(p.label), at: timeSpan([p.at, p.at])?.[0], firstPast: past, count: 0, past: 0 };
        batch.count++;
        if (past)
            batch.past++;
    }
    if (batch?.past) {
        // Append one integer per completed call. Concurrent ccc processes resuming
        // the same session can both contribute without a read/modify/write race.
        try {
            const dir = path.join(getConfigDir(), "recall-counts");
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            fs.appendFileSync(path.join(dir, key(input.session_id)), batch.past + "\n", { mode: 0o600 });
        }
        catch { /* The display can still succeed without the lifetime total. */ }
    }
    return batch;
}
export function pastRecallCount(session) {
    if (!session || process.env.CCC_RECALL_NOTICE === "0")
        return 0;
    try {
        const counts = fs.readFileSync(path.join(getConfigDir(), "recall-counts", key(session)), "utf8");
        return counts.trim().split("\n").reduce((sum, n) => sum + Number(n), 0);
    }
    catch {
        return 0;
    }
}
export function recallLine(batches, now = new Date()) {
    const first = batches[0];
    if (!first)
        return;
    let source = "earlier in this session";
    if (first.firstPast) {
        source = "a past session";
        if (first.at) {
            const date = new Date(first.at);
            const day = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
            const days = (day(now) - day(date)) / 86400000;
            if (days === 0)
                source = "today’s session";
            else if (days === 1)
                source = "yesterday’s session";
            else if (days > 1 && days < 7)
                source = date.toLocaleDateString("en-US", { weekday: "long" }) + "’s session";
            else
                source = "the session on " + date.toLocaleDateString("en-US", { month: "short", day: "numeric",
                    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
        }
    }
    const more = batches.reduce((n, b) => n + b.count, -1);
    return `🌿 MemTree recalled from ${source}${first.label ? ": " + first.label : ""}${more ? " …and " + more + " more" : ""}`;
}
/** Plain Claude Code has no ccc proxy to own a turn. One file per tool
 * handles parallel calls; an exclusive marker lets only one Stop claim it. */
export function standaloneRecall(input) {
    if (process.env[RECALL_WRAPPED] === "1" || process.env.CCC_RECALL_NOTICE === "0" ||
        !input?.session_id || !input.prompt_id)
        return;
    const turnDir = path.join(receiptsDir(), key(input.session_id, input.prompt_id));
    const shown = turnDir + "." + key("shown");
    if (input.hook_event_name === "PostToolUse" && input.tool_use_id) {
        const batch = recalled(input);
        if (batch && !fs.existsSync(shown)) {
            fs.mkdirSync(turnDir, { recursive: true, mode: 0o700 });
            const file = path.join(turnDir, Date.now() + "-" + key(input.tool_use_id));
            fs.writeFileSync(file, JSON.stringify(batch), { flag: "wx", mode: 0o600 });
        }
    }
    else if (input.hook_event_name === "Stop" && !input.agent_id && fs.existsSync(turnDir)) {
        fs.writeFileSync(shown, "", { flag: "wx", mode: 0o600 });
        try {
            const batches = fs.readdirSync(turnDir).sort().map(name => JSON.parse(fs.readFileSync(path.join(turnDir, name), "utf8")));
            return recallLine(batches);
        }
        finally {
            fs.rmSync(turnDir, { recursive: true, force: true });
        }
    }
}
export async function standaloneRecallHook() {
    try {
        let body = "";
        process.stdin.setEncoding("utf8");
        for await (const chunk of process.stdin) {
            body += chunk;
            if (body.length > 16 * 1024 * 1024)
                return;
        }
        const line = standaloneRecall(JSON.parse(body));
        if (line)
            process.stdout.write(JSON.stringify({ systemMessage: line }));
    }
    catch { /* No pending recalls or inaccessible state: silent successful hook. */ }
}
//# sourceMappingURL=recall.js.map