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
 * Every failure (no transcript, unreadable line, unknown shape) yields no
 * usage; the MemTree call goes out unchanged.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/** Longest text prefix hashed to identify a text-only response. */
const TEXT_KEY_CHARS = 400;
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
    usageFor(sessionId, messages) {
        try {
            const index = this.indexFor(sessionId);
            if (!index)
                return {};
            index.refresh();
            return index.match(messages);
        }
        catch {
            return {};
        }
    }
    indexFor(sessionId) {
        if (!/^[A-Za-z0-9-]+$/.test(sessionId))
            return undefined;
        const known = this.sessions.get(sessionId);
        if (known)
            return known;
        const file = findTranscript(this.projectsDir, sessionId);
        if (!file)
            return undefined;
        const index = new TranscriptIndex(file);
        this.sessions.set(sessionId, index);
        return index;
    }
}
/** `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
export function defaultProjectsDir(env = process.env) {
    const base = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    return path.join(base, "projects");
}
/** The session's transcript in whichever project directory holds it. */
export function findTranscript(projectsDir, sessionId) {
    let projects;
    try {
        projects = fs.readdirSync(projectsDir);
    }
    catch {
        return undefined;
    }
    for (const project of projects) {
        const file = path.join(projectsDir, project, `${sessionId}.jsonl`);
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
    idByText = new Map();
    /** Response id → its text so far (one transcript entry per content block). */
    textById = new Map();
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
    responseIdFor(message) {
        const parts = Array.isArray(message.content) ? message.content : [];
        for (const part of parts) {
            if (part?.type === "tool_use" && typeof part.id === "string") {
                const id = this.idByToolUse.get(part.id);
                if (id)
                    return id;
            }
        }
        const key = textKey(messageText(message));
        return key ? this.idByText.get(key) : undefined;
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
        if (entry?.type !== "assistant")
            return;
        const message = entry.message;
        const id = message?.id;
        if (typeof id !== "string")
            return;
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
                if (key)
                    this.idByText.set(key, id);
            }
        }
    }
    reset() {
        this.offset = 0;
        this.partial = "";
        this.usageById.clear();
        this.idByToolUse.clear();
        this.idByText.clear();
        this.textById.clear();
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
/** A short stable key for a response's text; empty text has none. */
function textKey(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return undefined;
    return createHash("sha256").update(trimmed.slice(0, TEXT_KEY_CHARS)).digest("hex").slice(0, 32);
}
//# sourceMappingURL=transcript-usage.js.map