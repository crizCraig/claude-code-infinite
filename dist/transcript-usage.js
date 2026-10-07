/**
 * Per-response token usage, read from Claude Code's own session transcript,
 * for the MemTree page to show how much of each response was thinking.
 *
 * Anthropic reports thinking only as a number on the response
 * (`usage.output_tokens_details.thinking_tokens`): the thinking text is mostly
 * omitted, and ccc strips thinking blocks before MemTree sees the history
 * anyway. Conversation history carries no usage and no message ids, so the
 * proxy cannot attach it on its own. Claude Code's transcript
 * (`~/.claude/projects/<project>/<session id>.jsonl`) records every
 * response's usage next to its content, and survives restarts and resumes, so
 * it is the source: each response is matched to the assistant message it
 * became by its tool-call ids, or by a hash of its text when it made none.
 *
 * The same transcript stamps every entry with the time Claude Code wrote it,
 * so it is also the source of each message's time (`timesFor`): an assistant
 * message takes its response's last entry, a user message the latest entry
 * among its tool results (by tool-call id) and typed text (by a hash of the
 * text without `<system-reminder>` blocks). Text can repeat ("yes", "Done."),
 * so a text match consumes the next unused entry at or after the previous message's.
 * A subagent's messages come from its own transcript,
 * `<session id>/subagents/agent-<agent id>.jsonl` next to the main one. MemTree records these per input
 * block, to tell which conversation and block is most recent.
 *
 * Every failure (no transcript, unreadable line, unknown shape) yields no
 * usage and no times; the MemTree call goes out unchanged.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { setImmediate as yieldTurn } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
/** Session and agent ids name files: no path separators or dots. */
const SAFE_ID = /^[A-Za-z0-9-]+$/;
/** Transcript bytes read per refresh; later calls pick up the rest. */
const MAX_READ_BYTES = 1024 * 1024;
/**
 * The most catchUp reads in one go. Far above any session seen (10 MB); the
 * cap only bounds a pathological file, which then finishes on later lookups.
 */
const MAX_CATCH_UP_BYTES = 256 * 1024 * 1024;
/** Oversized JSONL entries are optional metadata; discard them without accumulating. */
const MAX_LINE_BYTES = 1024 * 1024;
/**
 * Reads transcripts incrementally: each session's file is opened once and
 * only the bytes appended since the last call are parsed.
 */
export class ClaudeTranscriptUsage {
    projectsDir;
    sessions = new Map();
    constructor(projectsDir = defaultProjectsDir()) {
        this.projectsDir = projectsDir;
    }
    usageFor(sessionId, messages, agentId) {
        try {
            const index = this.indexFor(sessionId, agentId);
            if (!index)
                return {};
            index.refresh();
            return index.match(messages);
        }
        catch {
            return {};
        }
    }
    /**
     * Reads a session's transcript to its end now, off the request path. A
     * lookup reads one bounded chunk, so without this the first requests after
     * resuming a long session see only its oldest responses and undercount the
     * thinking MemTree's budget check relies on. Best effort: never throws.
     */
    catchUp(sessionId) {
        try {
            const index = this.indexFor(sessionId);
            let read = 0;
            while (index && read < MAX_CATCH_UP_BYTES) {
                const bytes = index.refresh();
                if (bytes === 0)
                    break;
                read += bytes;
            }
        }
        catch {
            // Lookups still read incrementally.
        }
    }
    timesFor(sessionId, messages, agentId) {
        try {
            const index = this.indexFor(sessionId, agentId);
            if (!index)
                return {};
            index.refresh();
            return index.matchTimes(messages);
        }
        catch {
            return {};
        }
    }
    finalReply(sessionId) {
        try {
            const index = this.indexFor(sessionId);
            if (!index)
                return undefined;
            let read = 0;
            while (read < MAX_CATCH_UP_BYTES) {
                const bytes = index.refresh();
                if (bytes === 0)
                    break;
                read += bytes;
            }
            return index.finalReply();
        }
        catch {
            return undefined;
        }
    }
    async finalReplyAsync(sessionId, signal) {
        await yieldTurn(undefined, { signal });
        try {
            const index = this.indexFor(sessionId);
            if (!index)
                return undefined;
            let read = 0;
            while (read < MAX_CATCH_UP_BYTES) {
                await yieldTurn(undefined, { signal });
                const bytes = index.refresh();
                if (bytes === 0)
                    return index.finalReply();
                read += bytes;
            }
            // A partial transcript cannot establish the latest turn's answer.
            return undefined;
        }
        catch {
            signal?.throwIfAborted();
            return undefined;
        }
    }
    indexFor(sessionId, agentId) {
        if (!SAFE_ID.test(sessionId))
            return undefined;
        if (agentId !== undefined && !SAFE_ID.test(agentId))
            return undefined;
        const key = agentId === undefined ? sessionId : `${sessionId}/${agentId}`;
        const known = this.sessions.get(key);
        if (known)
            return known;
        const file = findTranscript(this.projectsDir, sessionId, agentId);
        if (!file)
            return undefined;
        const index = new TranscriptIndex(file);
        this.sessions.set(key, index);
        return index;
    }
}
/** `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
export function defaultProjectsDir(env = process.env) {
    const base = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    return path.join(base, "projects");
}
/**
 * The session's transcript in whichever project directory holds it, or with
 * `agentId`, that subagent's. The id is accepted with or without its `agent-`
 * file prefix.
 */
export function findTranscript(projectsDir, sessionId, agentId) {
    const name = agentId === undefined
        ? `${sessionId}.jsonl`
        : path.join(sessionId, "subagents", `agent-${agentId.replace(/^agent-/, "")}.jsonl`);
    let projects;
    try {
        projects = fs.readdirSync(projectsDir);
    }
    catch {
        return undefined;
    }
    for (const project of projects) {
        const file = path.join(projectsDir, project, name);
        if (fs.existsSync(file))
            return file;
    }
    return undefined;
}
class TranscriptIndex {
    file;
    offset = 0;
    partial = Buffer.alloc(0);
    /** Skip to newline after an oversized line or a complete EOF record already ingested. */
    discardingOversizedLine = false;
    /** Response message id → its usage (the largest seen: entries repeat it). */
    usageById = new Map();
    idByToolUse = new Map();
    /** Response id → its text so far (one transcript entry per content block). */
    textById = new Map();
    /** Response id → its latest entry's time (thinking starts, last block lands). */
    timeById = new Map();
    /** tool_use_id → when its result was written. */
    timeByToolResult = new Map();
    /** Hash of typed user text (reminders removed) → every time it was written. */
    timesByUserText = new Map();
    /** Hash of a response's text → every response id with that text, in order. */
    idsByText = new Map();
    /** The newest response's id, and every response that called a tool. */
    lastResponseId;
    toolCallingIds = new Set();
    constructor(file) {
        this.file = file;
    }
    /** The newest response as a text-only assistant message, unless it called a tool. */
    finalReply() {
        const id = this.lastResponseId;
        if (id === undefined || this.toolCallingIds.has(id))
            return undefined;
        const text = this.textById.get(id);
        return text && text.trim() ? { role: "assistant", content: [{ type: "text", text }] } : undefined;
    }
    /** Reads the next bounded chunk; returns the bytes read (0 at the end). */
    refresh() {
        const size = fs.statSync(this.file).size;
        if (size < this.offset)
            this.reset(); // rewritten transcript
        if (size === this.offset)
            return 0;
        const length = Math.min(size - this.offset, MAX_READ_BYTES);
        const buffer = Buffer.alloc(length);
        const fd = fs.openSync(this.file, "r");
        let bytesRead;
        try {
            bytesRead = fs.readSync(fd, buffer, 0, length, this.offset);
        }
        finally {
            fs.closeSync(fd);
        }
        this.offset += bytesRead;
        // One bounded read per refresh, even while discarding: a corrupt line must
        // never turn optional metadata lookup into a synchronous scan to EOF.
        let bytes = buffer.subarray(0, bytesRead);
        if (this.discardingOversizedLine) {
            const newline = bytes.indexOf(10);
            if (newline < 0)
                return bytesRead;
            bytes = bytes.subarray(newline + 1);
            this.discardingOversizedLine = false;
        }
        // Keep bytes intact until a whole line is available, including UTF-8
        // characters split across reads. Both operands are independently bounded.
        const lines = this.partial.length ? Buffer.concat([this.partial, bytes]) : bytes;
        this.partial = Buffer.alloc(0);
        let start = 0;
        let newline;
        while ((newline = lines.indexOf(10, start)) >= 0) {
            if (newline - start <= MAX_LINE_BYTES) {
                this.ingest(lines.toString("utf-8", start, newline));
            }
            start = newline + 1;
        }
        const remaining = lines.length - start;
        if (remaining > MAX_LINE_BYTES) {
            this.discardingOversizedLine = true;
        }
        else if (remaining) {
            // Copy only the tail, rather than retaining the whole read buffer.
            this.partial = Buffer.from(lines.subarray(start));
            if (this.offset === size)
                this.ingestCompleteEof();
        }
        return bytesRead;
    }
    ingestCompleteEof() {
        const line = this.partial.toString("utf-8");
        try {
            JSON.parse(line);
        }
        catch {
            return; // A writer may still be appending this JSON record.
        }
        this.ingest(line);
        this.partial = Buffer.alloc(0);
        // A later newline terminates this same record; don't ingest it twice.
        this.discardingOversizedLine = true;
    }
    match(messages) {
        const out = {};
        // Reserve identities before matching any text, including identities in
        // ambiguous messages. Input order must not let a text-only reply steal a
        // response that another message identifies by its tool calls.
        const claims = new Map();
        const textCounts = new Map();
        const matches = messages.map((message) => {
            if (message?.role !== "assistant")
                return undefined;
            const ids = new Set();
            let hasTools = false;
            let unknownTool = false;
            for (const part of Array.isArray(message.content) ? message.content : []) {
                if (part?.type !== "tool_use")
                    continue;
                hasTools = true;
                const id = typeof part.id === "string" ? this.idByToolUse.get(part.id) : undefined;
                if (id)
                    ids.add(id);
                else
                    unknownTool = true;
            }
            for (const id of ids)
                claims.set(id, (claims.get(id) ?? 0) + 1);
            const text = messageText(message).trim();
            if (!hasTools && text)
                textCounts.set(text, (textCounts.get(text) ?? 0) + 1);
            return { ids, hasTools, unknownTool, text };
        });
        matches.forEach((match, index) => {
            if (!match)
                return;
            let id;
            if (match.hasTools) {
                if (match.unknownTool || match.ids.size !== 1)
                    return;
                const candidate = match.ids.values().next().value;
                if (claims.get(candidate) !== 1)
                    return;
                id = candidate;
            }
            else {
                if (!match.text || textCounts.get(match.text) !== 1)
                    return;
                const key = textKey(match.text);
                const candidates = (key ? this.idsByText.get(key) ?? [] : []).filter((candidate) => !claims.has(candidate) && this.textById.get(candidate)?.trim() === match.text);
                // A subset of history can contain any occurrence of repeated text.
                // Neither first nor last is safe to guess, even if usage is missing
                // for one candidate; omit uncertain metadata instead.
                if (candidates.length !== 1)
                    return;
                id = candidates[0];
            }
            const usage = this.usageById.get(id);
            if (usage)
                out[String(index)] = usage;
        });
        return out;
    }
    matchTimes(messages) {
        const out = {};
        const userCursors = new Map();
        const responseCursors = new Map();
        const usedResponses = new Set();
        // Latest time assigned so far: repeated text matches forward from it.
        let floor;
        messages.forEach((message, index) => {
            const time = message?.role === "assistant"
                ? this.timeForResponse(message, floor, responseCursors, usedResponses)
                : message?.role === "user"
                    ? this.timeForUser(message, floor, userCursors)
                    : undefined;
            if (time) {
                out[String(index)] = time;
                floor = latest([floor, time]);
            }
        });
        return out;
    }
    timeForResponse(message, floor, cursors, used) {
        for (const part of Array.isArray(message.content) ? message.content : []) {
            if (part?.type === "tool_use" && typeof part.id === "string") {
                const id = this.idByToolUse.get(part.id);
                if (id) {
                    if (used.has(id))
                        return undefined;
                    used.add(id);
                    return this.timeById.get(id);
                }
            }
        }
        const text = messageText(message).trim();
        const key = textKey(text);
        if (!key)
            return undefined;
        const ids = this.idsByText.get(key) ?? [];
        for (let i = cursors.get(key) ?? 0; i < ids.length; i++) {
            cursors.set(key, i + 1);
            const id = ids[i];
            const time = this.timeById.get(id);
            if (used.has(id) || this.textById.get(id)?.trim() !== text)
                continue;
            if (!time || (floor && time < floor))
                continue;
            used.add(id);
            return time;
        }
        return undefined;
    }
    /** Latest time among the entries this message was built from. */
    timeForUser(message, floor, cursors) {
        const times = [];
        const typed = (text) => {
            const key = userTextKey(text);
            if (!key)
                return undefined;
            const entries = this.timesByUserText.get(key) ?? [];
            for (let i = cursors.get(key) ?? 0; i < entries.length; i++) {
                cursors.set(key, i + 1);
                if (!floor || entries[i] >= floor)
                    return entries[i];
            }
            return undefined;
        };
        if (typeof message.content === "string")
            times.push(typed(message.content));
        for (const part of Array.isArray(message.content) ? message.content : []) {
            if (part?.type === "tool_result" && typeof part.tool_use_id === "string") {
                times.push(this.timeByToolResult.get(part.tool_use_id));
            }
            else if (part?.type === "text" && typeof part.text === "string") {
                times.push(typed(part.text));
            }
        }
        return latest(times);
    }
    ingest(line) {
        if (!line.trim())
            return;
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            return;
        }
        const time = entryTime(entry);
        if (entry?.type === "user") {
            // A later user/tool-result entry starts an unanswered turn. An exit
            // before its response must not append the preceding turn's answer.
            this.lastResponseId = undefined;
            if (time)
                this.ingestUserTime(entry.message, time);
            return;
        }
        if (entry?.type !== "assistant")
            return;
        const message = entry.message;
        const id = message?.id;
        if (typeof id !== "string")
            return;
        this.lastResponseId = id;
        if (time)
            this.timeById.set(id, latest([this.timeById.get(id), time]));
        const usage = toUsage(message.usage);
        if (usage) {
            const seen = this.usageById.get(id);
            if (!seen || usage.output_tokens >= seen.output_tokens)
                this.usageById.set(id, usage);
        }
        for (const part of Array.isArray(message.content) ? message.content : []) {
            if (part?.type === "tool_use" && typeof part.id === "string") {
                this.idByToolUse.set(part.id, id);
                this.toolCallingIds.add(id);
            }
            else if (part?.type === "text" && typeof part.text === "string") {
                const text = (this.textById.get(id) ?? "") + part.text;
                this.textById.set(id, text);
                const key = textKey(text);
                if (key) {
                    appendOnce(this.idsByText, key, id);
                }
            }
        }
    }
    ingestUserTime(message, time) {
        const content = message?.content;
        if (typeof content === "string") {
            const key = userTextKey(content);
            if (key)
                appendTime(this.timesByUserText, key, time);
            return;
        }
        for (const part of Array.isArray(content) ? content : []) {
            if (part?.type === "tool_result" && typeof part.tool_use_id === "string") {
                this.timeByToolResult.set(part.tool_use_id, time);
            }
            else if (part?.type === "text" && typeof part.text === "string") {
                const key = userTextKey(part.text);
                if (key)
                    appendTime(this.timesByUserText, key, time);
            }
        }
    }
    reset() {
        this.offset = 0;
        this.partial = Buffer.alloc(0);
        this.discardingOversizedLine = false;
        this.usageById.clear();
        this.idByToolUse.clear();
        this.textById.clear();
        this.timeById.clear();
        this.timeByToolResult.clear();
        this.timesByUserText.clear();
        this.idsByText.clear();
        this.lastResponseId = undefined;
        this.toolCallingIds.clear();
    }
}
function toUsage(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.output_tokens !== "number")
        return undefined;
    const usage = {
        output_tokens: raw.output_tokens,
        thinking_tokens: typeof raw.output_tokens_details?.thinking_tokens === "number"
            ? raw.output_tokens_details.thinking_tokens
            : 0,
    };
    for (const field of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
        if (typeof raw[field] === "number")
            usage[field] = raw[field];
    }
    return usage;
}
function messageText(message) {
    if (typeof message.content === "string")
        return message.content;
    if (!Array.isArray(message.content))
        return "";
    return message.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
}
/** Hash the entire normalized text: shared prefixes must never identify a message. */
function textKey(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return undefined;
    return createHash("sha256").update(trimmed).digest("hex").slice(0, 32);
}
/** The entry's ISO time, normalized; entries without a parseable one have none. */
function entryTime(entry) {
    const raw = entry?.timestamp;
    if (typeof raw !== "string")
        return undefined;
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}
/** The latest of some ISO times (all normalized by entryTime, so they sort as text). */
function latest(times) {
    let best;
    for (const time of times)
        if (time && (!best || time > best))
            best = time;
    return best;
}
/** Keep separate entries even when they have identical millisecond timestamps. */
function appendTime(map, key, time) {
    const times = map.get(key);
    if (times)
        times.push(time);
    else
        map.set(key, [time]);
}
function appendOnce(map, key, value) {
    const list = map.get(key);
    if (!list)
        map.set(key, [value]);
    else if (list[list.length - 1] !== value)
        list.push(value);
}
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
/** Typed text keyed without Claude Code's reminders, which the API copy may add or drop. */
function userTextKey(text) {
    return textKey(text.replace(SYSTEM_REMINDER_RE, ""));
}
//# sourceMappingURL=transcript-usage.js.map