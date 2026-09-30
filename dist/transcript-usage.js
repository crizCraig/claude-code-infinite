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
import os from "node:os";
import path from "node:path";
/** Session and agent ids name files: no path separators or dots. */
const SAFE_ID = /^[A-Za-z0-9-]+$/;
/** Transcript bytes read per refresh; later calls pick up the rest. */
const MAX_READ_BYTES = 64 * 1024 * 1024;
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
    partial = "";
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
    constructor(file) {
        this.file = file;
    }
    refresh() {
        const size = fs.statSync(this.file).size;
        if (size < this.offset)
            this.reset(); // rewritten transcript
        if (size === this.offset)
            return;
        const length = Math.min(size - this.offset, MAX_READ_BYTES);
        const buffer = Buffer.alloc(length);
        const fd = fs.openSync(this.file, "r");
        try {
            fs.readSync(fd, buffer, 0, length, this.offset);
        }
        finally {
            fs.closeSync(fd);
        }
        this.offset += length;
        const lines = (this.partial + buffer.toString("utf-8")).split("\n");
        this.partial = lines.pop() ?? "";
        for (const line of lines)
            this.ingest(line);
    }
    match(messages) {
        const out = {};
        messages.forEach((message, index) => {
            if (message?.role !== "assistant")
                return;
            const id = this.responseIdFor(message);
            const usage = id !== undefined ? this.usageById.get(id) : undefined;
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
    responseIdFor(message) {
        const parts = Array.isArray(message.content) ? message.content : [];
        for (const part of parts) {
            if (part?.type === "tool_use" && typeof part.id === "string") {
                const id = this.idByToolUse.get(part.id);
                if (id)
                    return id;
            }
        }
        const text = messageText(message).trim();
        const key = textKey(text);
        const ids = key ? this.idsByText.get(key) : undefined;
        return ids?.findLast((id) => this.textById.get(id)?.trim() === text);
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
        this.partial = "";
        this.usageById.clear();
        this.idByToolUse.clear();
        this.textById.clear();
        this.timeById.clear();
        this.timeByToolResult.clear();
        this.timesByUserText.clear();
        this.idsByText.clear();
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