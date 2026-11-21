/** Display-only recall. Claude Code passes the same tool-use ID to MCP and
 * the hooks. PreToolUse creates a one-call ticket and PostToolUse verifies the result
 * (even a large result that Claude Code spills to disk before the hook). */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getConfigDir, memtreeStorageIdentity } from "./config.js";
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
const files = fs.promises;
const ttl = 10 * 60_000;
let lastPruned = 0;
async function prune(dir) {
    if (Date.now() - lastPruned < ttl)
        return;
    lastPruned = Date.now();
    for (const name of await files.readdir(dir)) {
        // Includes the previous version's abandoned turn directories.
        if (!/^[a-f0-9]{64}(?:[.][a-f0-9.-]+)?$/.test(name))
            continue;
        const file = path.join(dir, name);
        try {
            if (Date.now() - (await files.lstat(file)).mtimeMs > 86400000) {
                await files.rm(file, { recursive: true, force: true });
            }
        }
        catch { /* Claimed concurrently. */ }
    }
}
async function publishFile(file, data) {
    const tmp = file + "." + randomUUID();
    await files.mkdir(path.dirname(file), { mode: 0o700, recursive: true });
    try {
        await files.writeFile(tmp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
        await files.rename(tmp, file);
    }
    finally {
        await files.rm(tmp, { force: true });
    }
}
function ticketFile(session, tool, id) {
    return path.join(receiptsDir(), key("call", session, tool, id));
}
// Wrapped PreToolUse returns immediately. While a replacement ticket is being
// published, its PostToolUse must skip even a byte-identical older receipt.
const publishingTickets = new Map();
export async function beginRecall(input, account) {
    if (process.env.CCC_RECALL_NOTICE === "0" || !account || input.hook_event_name !== "PreToolUse" ||
        !input.session_id || !input.prompt_id || !input.tool_use_id || !input.tool_name || !matcher.test(input.tool_name))
        return;
    const file = ticketFile(input.session_id, input.tool_name, input.tool_use_id);
    const ticket = { account, nonce: randomUUID(), at: Date.now(), prompt: input.prompt_id, agent: input.agent_id };
    const write = () => publishFile(file, ticket);
    const previous = publishingTickets.get(file);
    const pending = previous ? previous.then(write, write) : write();
    publishingTickets.set(file, pending);
    try {
        await pending;
    }
    catch (error) {
        // After the previous ticket expires it cannot authorize a receipt either.
        setTimeout(() => {
            if (publishingTickets.get(file) === pending)
                publishingTickets.delete(file);
        }, ttl).unref();
        throw error;
    }
    if (publishingTickets.get(file) === pending)
        publishingTickets.delete(file);
}
async function readTicket(account, session, tool, id) {
    const file = ticketFile(session, tool, id);
    if (publishingTickets.has(file))
        return;
    try {
        const ticket = JSON.parse(await files.readFile(file, "utf8"));
        if (ticket.account === account && typeof ticket.nonce === "string" &&
            ticket.at <= Date.now() && ticket.at >= Date.now() - ttl)
            return ticket;
    }
    catch { /* No matching PreToolUse. */ }
}
function receiptFile(account, session, tool, id, nonce) {
    return path.join(receiptsDir(), key("receipt", account, session, tool, id, nonce));
}
export async function withRecallReceipt(tool, id, answer, invocation) {
    if (process.env[RECALL_ACTIVE] !== "1" || process.env.CCC_RECALL_NOTICE === "0" ||
        !invocation?.account || !invocation.session || typeof id !== "string" || !id ||
        !matcher.test("mcp__memtree__" + tool))
        return answer();
    const passages = [];
    const name = "mcp__memtree__" + tool;
    // Capture the ticket before running the tool. A replay gets a fresh nonce even
    // if it returns identical text, fails, or uses a different registration.
    const ticket = await readTicket(invocation.account, invocation.session, name, id);
    if (!ticket)
        return answer();
    void prune(receiptsDir()).catch(() => { });
    const text = await collecting.run({ session: invocation.session, passages }, answer);
    if (!passages.length)
        return text;
    const file = receiptFile(invocation.account, invocation.session, name, id, ticket.nonce);
    const write = async () => {
        try {
            await publishFile(file, { at: Date.now(), digest: digest(text), size: Buffer.byteLength(text), passages });
        }
        catch { /* Delivery of the tool result is independent of the optional UI. */ }
    };
    if (invocation.afterReply)
        invocation.afterReply(write);
    else
        await write();
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
export function recallPassage(session, summary, at) {
    const call = collecting.getStore();
    if (!call || typeof session !== "string" || !session || session.length > 128 || session === call.session)
        return;
    // Older page headers use the server's UTC display format.
    const instant = typeof at === "string" ? at.replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC$/, "$1T$2Z") : at;
    const date = timeSpan([instant, instant])?.[0];
    call.passages.push({ session, label: shortLabel(summary), at: date });
}
/** Rename claims one complete file even when multiple hooks race. */
async function claim(file) {
    const claimed = file + "." + randomUUID();
    try {
        await files.rename(file, claimed);
    }
    catch {
        return;
    }
    try {
        return JSON.parse(await files.readFile(claimed, "utf8"));
    }
    finally {
        await files.rm(claimed, { force: true });
    }
}
async function matchesAnswer(input, receipt) {
    const result = input.tool_response;
    const text = Array.isArray(result) && result.length === 1 && result[0]?.type === "text" ? result[0].text : result;
    if (typeof text !== "string")
        return false;
    if (Buffer.byteLength(text) === receipt.size && digest(text) === receipt.digest)
        return true;
    // Claude replaces oversized MCP text with a pointer. Verify the exact bytes in its
    // own session's tool-results folder. A pointer alone is insufficient evidence.
    const saved = /^Error: result [^\n]+ Output has been saved to ([^\r\n]+)\.\r?\nFormat: Plain text\b/.exec(text)?.[1];
    if (!saved || !path.isAbsolute(saved))
        return false;
    const root = await files.realpath(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects"));
    const actual = await files.realpath(saved);
    const parts = path.relative(root, actual).split(path.sep);
    if (parts.length !== 4 || parts[0] === ".." || parts[1] !== input.session_id || parts[2] !== "tool-results" ||
        !parts[3].startsWith("mcp-memtree-" + input.tool_name.slice("mcp__memtree__".length) + "-"))
        return false;
    const stat = await files.stat(actual);
    return stat.isFile() && stat.size === receipt.size && digest(await files.readFile(actual)) === receipt.digest;
}
export async function recalled(input, account) {
    if (!account || process.env.CCC_RECALL_NOTICE === "0" || input?.hook_event_name !== "PostToolUse" ||
        !input.tool_name || !matcher.test(input.tool_name) || !input.session_id || !input.prompt_id ||
        typeof input.tool_use_id !== "string" || !input.tool_use_id)
        return;
    const ticket = await readTicket(account, input.session_id, input.tool_name, input.tool_use_id);
    if (!ticket || input.prompt_id !== ticket.prompt || input.agent_id !== ticket.agent)
        return;
    const file = receiptFile(account, input.session_id, input.tool_name, input.tool_use_id, ticket.nonce);
    let receipt;
    try {
        receipt = await claim(file);
        if (!receipt || !(receipt.at <= Date.now() && receipt.at >= Date.now() - ttl) ||
            !Array.isArray(receipt.passages) || !await matchesAnswer(input, receipt))
            return;
    }
    catch {
        return;
    }
    // Receipts left by an older MCP process may still contain current-session passages.
    const past = receipt.passages.filter(p => p.session && p.session !== input.session_id);
    const first = past[0];
    if (!first)
        return;
    const at = first.at ?? past.find(p => p.session === first.session && p.at)?.at;
    const batch = { session: first.session, label: shortLabel(first.label), at, count: past.length };
    try {
        const dir = path.join(getConfigDir(), "recall-counts");
        await files.mkdir(dir, { recursive: true, mode: 0o700 });
        await files.appendFile(path.join(dir, key(account, input.session_id)), batch.count + "\n", { mode: 0o600 });
    }
    catch { /* The display can still succeed without the lifetime total. */ }
    return batch;
}
export function pastRecallCount(session, account) {
    if (!session || !account || process.env.CCC_RECALL_NOTICE === "0")
        return 0;
    try {
        const counts = fs.readFileSync(path.join(getConfigDir(), "recall-counts", key(account, session)), "utf8");
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
    let source = "a past session";
    const at = first.at ?? batches.find(b => b.session === first.session && b.at)?.at;
    if (at) {
        const date = new Date(at);
        const day = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
        const days = (day(now) - day(date)) / 86400000;
        if (days === 0)
            source = "today’s session";
        else if (days === 1)
            source = "yesterday’s session";
        else if (days > 1 && days < 7)
            source = date.toLocaleDateString("en-US", { weekday: "long" }) + "’s session";
        else
            source = "a session on " + date.toLocaleDateString("en-US", { month: "short", day: "numeric",
                ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
    }
    const more = batches.reduce((n, b) => n + b.count, -1);
    return `🌿 MemTree recalled from ${source}${first.label ? ": " + first.label : ""}${more ? " …and " + more + " more" : ""}`;
}
function shownFile(session, prompt) {
    return path.join(getConfigDir(), "recall-shown", key(session), key(prompt));
}
/** Direct hooks run in separate processes. Only the Stop that creates this
 * marker can announce the prompt, including after a resume. */
export async function claimRecallPrompt(session, prompt) {
    const file = shownFile(session, prompt);
    try {
        await files.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await files.writeFile(file, "", { flag: "wx", mode: 0o600 });
        return true;
    }
    catch {
        return false;
    }
}
/** Only the matching prompt owns host calls. Background agents can finish after
 * that prompt's Stop, so the next parent Stop in the same session can claim them. */
export async function standaloneRecall(input, account) {
    if (!account || process.env[RECALL_WRAPPED] === "1" || process.env.CCC_RECALL_NOTICE === "0" ||
        !input?.session_id || !input.prompt_id)
        return;
    if (input.hook_event_name === "PreToolUse") {
        await beginRecall(input, account);
        return;
    }
    const host = key("host", account, input.session_id, input.prompt_id);
    const agents = key("agents", account, input.session_id);
    const dir = path.join(receiptsDir(), key("pending-past", account, input.session_id));
    if (input.hook_event_name === "PostToolUse") {
        const batch = await recalled(input, account);
        if (batch) {
            const name = (input.agent_id ? agents : host) + "." + Date.now() + "." + randomUUID();
            await publishFile(path.join(dir, name), batch);
        }
    }
    else if (input.hook_event_name === "Stop" && !input.agent_id) {
        const names = await files.readdir(dir).catch(() => []);
        const eligible = [];
        for (const name of names.sort((a, b) => a.slice(65).localeCompare(b.slice(65)))) {
            const [owner, at, id, extra] = name.split(".");
            if (!id || extra)
                continue;
            if (Number(at) < Date.now() - 86400000) {
                await files.rm(path.join(dir, name), { force: true });
                continue;
            }
            if (owner !== host && owner !== agents)
                continue;
            eligible.push(name);
        }
        if (!eligible.length)
            return;
        // Leave late agent results for another prompt if this one already displayed.
        if (!await claimRecallPrompt(input.session_id, input.prompt_id))
            return;
        const batches = [];
        for (const name of eligible) {
            const batch = await claim(path.join(dir, name));
            if (batch)
                batches.push(batch);
        }
        if (batches.length)
            return recallLine(batches);
        // Another prompt claimed the shared agent results. This prompt is still eligible.
        await files.rm(shownFile(input.session_id, input.prompt_id), { force: true });
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
        if (process.env[RECALL_WRAPPED] === "1" || process.env.CCC_RECALL_NOTICE === "0")
            return;
        const mode = process.argv[3] ?? "production";
        if (mode !== "production" && mode !== "staging")
            return;
        const { directCredentials } = await import("./direct-credentials.js");
        const { baseUrl, apiKey } = directCredentials(mode, process.env);
        const line = await standaloneRecall(JSON.parse(body), memtreeStorageIdentity(baseUrl, apiKey));
        if (line)
            process.stdout.write(JSON.stringify({ systemMessage: line }));
    }
    catch { /* No pending recalls or inaccessible state: silent successful hook. */ }
}
//# sourceMappingURL=recall.js.map