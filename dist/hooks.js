/**
 * Display-only Claude Code hook support for MemTree notices.
 *
 * Notices must never be represented as Anthropic assistant content: Claude
 * Code can reuse that content for hidden requests such as away recaps. Modern
 * Claude Code releases provide MessageDisplay, whose output changes only the
 * rendered delta. Stop's top-level systemMessage is the fallback for turns
 * that never render text (for example, a tool-only response).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export const MESSAGE_DISPLAY_MIN_VERSION = "2.1.166";
export const DEFAULT_NOTICE_TTL_MS = 60 * 60 * 1000;
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_DEFAULT_FOREGROUND = "\x1b[39m";
const STARTUP_NOTICE_FILE = "startup-notice.json";
/** Respect explicit monochrome settings and Node's platform color detection. */
export function terminalSupportsColor(env = process.env, stream = process.stdout) {
    if (Object.prototype.hasOwnProperty.call(env, "NO_COLOR"))
        return false;
    if (env.TERM?.toLowerCase() === "dumb")
        return false;
    try {
        if (typeof stream.hasColors === "function") {
            return stream.hasColors(8, env);
        }
    }
    catch {
        // Unknown/custom stream: Claude Code itself still handles standard SGR.
    }
    return true;
}
/**
 * Single-session delivery queue. Claude Code serializes main-thread turns, so
 * one replaceable pending notice is sufficient. A new user request clears any
 * stale notice; tool-result requests deliberately do not.
 */
export class NoticeDeliveryQueue {
    ttlMs;
    now;
    color;
    pending = null;
    constructor(ttlMs = DEFAULT_NOTICE_TTL_MS, now = Date.now, color = terminalSupportsColor()) {
        this.ttlMs = ttlMs;
        this.now = now;
        this.color = color;
    }
    /** Replace stale delivery state when a new main human prompt is submitted. */
    clearForUserRequest() {
        this.pending = null;
    }
    queuePrefix(text, onDelivered, promptId) {
        this.pending = {
            createdAt: this.now(),
            promptId,
            prefix: { text, onDelivered },
        };
    }
    queueSuffix(text, onDelivered, promptId) {
        this.pending = {
            createdAt: this.now(),
            promptId,
            suffix: { text, onDelivered },
        };
    }
    /**
     * Claim eligible notice parts atomically for one hook invocation. Subagent
     * hooks share the plugin but must never consume the main turn's notice.
     */
    claim(input) {
        if (input.agent_id !== undefined)
            return null;
        if (input.hook_event_name === "MessageDisplay") {
            return this.claimForDisplay(input);
        }
        if (input.hook_event_name !== "Stop")
            return null;
        const pending = this.freshPending();
        if (!pending || !this.promptMatches(pending, input.prompt_id))
            return null;
        const prefix = pending.prefix;
        const suffix = pending.suffix;
        if (!prefix && !suffix)
            return null;
        this.pending = null;
        markDelivered(prefix);
        markDelivered(suffix);
        const lines = [];
        if (prefix)
            lines.push(this.styleSuccess(resolveNoticeText(prefix)));
        if (suffix)
            lines.push(this.styleWarning(resolveNoticeText(suffix)));
        return {
            systemMessage: lines.join("\n"),
        };
    }
    claimForDisplay(input) {
        const pending = this.freshPending();
        const matched = pending && this.promptMatches(pending, input.prompt_id) ? pending : null;
        const prefix = matched && input.index === 0 ? matched.prefix : undefined;
        const suffix = matched && input.final ? matched.suffix : undefined;
        if (!prefix && !suffix)
            return null;
        // Remove before callbacks or response construction so a reentrant/parallel
        // Stop hook cannot deliver the same notice a second time.
        if (prefix)
            delete matched.prefix;
        if (suffix)
            delete matched.suffix;
        this.dropIfEmpty(matched);
        markDelivered(prefix);
        markDelivered(suffix);
        let displayContent = input.delta;
        if (prefix) {
            // MessageDisplay exposes text rather than a structured style token.
            // Standard named-color SGR is interpreted by Claude Code on every
            // supported terminal (and stripped cleanly in monochrome/NO_COLOR).
            // Reset foreground only so surrounding renderer styles are preserved.
            const styled = this.styleSuccess(resolveNoticeText(prefix));
            displayContent = `${styled}\n${displayContent}`;
        }
        if (suffix) {
            const separator = displayContent && !displayContent.endsWith("\n") ? "\n" : "";
            const styled = this.styleWarning(resolveNoticeText(suffix));
            displayContent = `${displayContent}${separator}${styled}`;
        }
        return {
            hookSpecificOutput: {
                hookEventName: "MessageDisplay",
                displayContent,
            },
        };
    }
    promptMatches(pending, promptId) {
        return (pending.promptId === undefined ||
            promptId === undefined ||
            pending.promptId === promptId);
    }
    styleSuccess(text) {
        return this.style(text, ANSI_GREEN);
    }
    /** Warnings get the same own-line treatment as success, in yellow. */
    styleWarning(text) {
        return this.style(text, ANSI_YELLOW);
    }
    style(text, sgr) {
        return this.color ? `${sgr}${text}${ANSI_DEFAULT_FOREGROUND}` : text;
    }
    freshPending() {
        if (!this.pending)
            return null;
        if (this.now() - this.pending.createdAt > this.ttlMs) {
            this.pending = null;
            return null;
        }
        return this.pending;
    }
    dropIfEmpty(pending) {
        if (!pending.prefix && !pending.suffix && this.pending === pending) {
            this.pending = null;
        }
    }
}
function resolveNoticeText(part) {
    try {
        return typeof part.text === "function" ? part.text() : part.text;
    }
    catch {
        // A late metrics formatter must never break the display hook.
        return "";
    }
}
function markDelivered(part) {
    if (!part?.onDelivered)
        return;
    try {
        part.onDelivered();
    }
    catch {
        // UI delivery succeeded; accounting callbacks must not break the hook.
    }
}
/** Strictly validate the subset of Claude hook input that delivery relies on. */
export function parseNoticeHookInput(value) {
    if (!value || typeof value !== "object")
        return null;
    const input = value;
    if (typeof input.session_id !== "string" || input.session_id.length === 0) {
        return null;
    }
    if (input.agent_id !== undefined && typeof input.agent_id !== "string") {
        return null;
    }
    if (input.prompt_id !== undefined && typeof input.prompt_id !== "string") {
        return null;
    }
    if (input.hook_event_name === "MessageDisplay") {
        if (typeof input.turn_id !== "string" ||
            typeof input.message_id !== "string" ||
            !Number.isInteger(input.index) ||
            input.index < 0 ||
            typeof input.final !== "boolean" ||
            typeof input.delta !== "string") {
            return null;
        }
        return input;
    }
    if (input.hook_event_name === "Stop") {
        if (input.stop_hook_active !== undefined &&
            typeof input.stop_hook_active !== "boolean") {
            return null;
        }
        return input;
    }
    if (input.hook_event_name === "UserPromptSubmit") {
        if (typeof input.prompt !== "string")
            return null;
        return input;
    }
    if (input.hook_event_name === "SubagentStart" ||
        input.hook_event_name === "SubagentStop") {
        if (typeof input.agent_id !== "string" || input.agent_id.length === 0) {
            return null;
        }
        if (input.agent_type !== undefined && typeof input.agent_type !== "string") {
            return null;
        }
        return input;
    }
    return null;
}
/** Prepend the repeatable global option without disturbing any user argv. */
export function withSessionNoticePluginArgs(args, pluginDir) {
    return ["--plugin-dir", pluginDir, ...args];
}
/**
 * Build a minimal session-only plugin. --plugin-dir is repeatable, unlike
 * --settings (where Claude keeps only the final occurrence), so this composes
 * with all user settings and hooks.
 */
export function createSessionNoticePlugin(hookUrl, opts = {}) {
    const url = new URL(hookUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
        throw new Error("notice hook URL must use randomized localhost HTTP endpoint");
    }
    const dir = fs.mkdtempSync(path.join(opts.tempRoot ?? os.tmpdir(), "ccc-notice-plugin-"));
    const manifestDir = path.join(dir, ".claude-plugin");
    const hooksDir = path.join(dir, "hooks");
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.mkdirSync(hooksDir, { recursive: true });
    const hook = { type: "http", url: hookUrl, timeout: 5 };
    const hooks = {
        Stop: [{ hooks: [hook] }],
        UserPromptSubmit: [{ hooks: [hook] }],
        SubagentStart: [{ hooks: [hook] }],
        SubagentStop: [{ hooks: [hook] }],
    };
    if (opts.messageDisplay !== false) {
        hooks.MessageDisplay = [{ hooks: [hook] }];
    }
    if (opts.startupMessage) {
        // SessionStart accepts only `command`/`mcp_tool` hooks — never `http` —
        // so the banner is baked into a static file the command simply cats. It
        // must NOT be `echo`'d: sh and zsh expand backslash escapes, turning the
        // JSON's \n into a raw newline and silently corrupting the payload.
        fs.writeFileSync(path.join(hooksDir, STARTUP_NOTICE_FILE), JSON.stringify({ systemMessage: opts.startupMessage }), { mode: 0o600 });
        hooks.SessionStart = [
            {
                // A compaction continues the same conversation; only real session
                // starts (fresh, --resume, /clear) re-show the banner.
                matcher: "startup|resume|clear",
                hooks: [
                    {
                        type: "command",
                        command: `cat ${singleQuoteForShell(path.join(hooksDir, STARTUP_NOTICE_FILE))}`,
                        timeout: 5,
                    },
                ],
            },
        ];
    }
    fs.writeFileSync(path.join(manifestDir, "plugin.json"), JSON.stringify({
        name: "ccc-session-notices",
        version: "1.0.0",
        description: "Session-only display hooks for Claude Code Infinite",
    }), { mode: 0o600 });
    fs.writeFileSync(path.join(hooksDir, "hooks.json"), JSON.stringify({ description: "Display MemTree state", hooks }), { mode: 0o600 });
    let closed = false;
    return {
        dir,
        close() {
            if (closed)
                return;
            closed = true;
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}
/**
 * POSIX single-quoting: everything inside is literal, and an embedded quote is
 * spliced in as '\''. The mkdtemp path is ours, but quoting keeps a hostile
 * TMPDIR from turning the hook command into arbitrary shell.
 */
function singleQuoteForShell(text) {
    return `'${text.replace(/'/g, `'\\''`)}'`;
}
/** Return true only for known Claude versions that support MessageDisplay. */
export function supportsMessageDisplay(versionOutput) {
    const match = versionOutput.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    if (!match)
        return false;
    const current = match.slice(1, 4).map(Number);
    const minimum = MESSAGE_DISPLAY_MIN_VERSION.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        if (current[i] !== minimum[i])
            return current[i] > minimum[i];
    }
    return true;
}
//# sourceMappingURL=hooks.js.map