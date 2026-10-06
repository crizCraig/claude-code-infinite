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
/** Trailer labels; kept here so hooks.ts stays free of notices.ts imports. */
export const TRAILER_LABEL = "• MemTree ·";
/** Label on a line that carries a MemTree page link. */
export const LINK_LABEL = "• MemTree";
/**
 * A MemTree link notice: the label (and note, if any) on the first line and
 * the URL alone, indented, on the next, so a long URL wraps on its own
 * rather than dragging the label or note onto a second line. Label and note
 * come pre-styled; the URL stays bare for the terminal's linkifier.
 */
export function linkLines(label, url, note) {
    return `${label}${note ? ` · ${note}` : ""}\n  ${url}`;
}
export const DEFAULT_NOTICE_TTL_MS = 60 * 60 * 1000;
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_DEFAULT_FOREGROUND = "\x1b[39m";
const ANSI_DIM = "\x1b[2m";
const ANSI_NORMAL_INTENSITY = "\x1b[22m";
const STARTUP_NOTICE_FILE = "startup-notice.json";
const RESUME_RELAY_FILE = "resume-link.mjs";
/**
 * `/memtree`: list the MemTree commands. The link label reads `/memtree` as a
 * hint, and typing it exactly must not dead-end in "Unknown command".
 */
export const MEMTREE_HELP_COMMAND = "memtree";
/** The session plugin's name, which prefixes its commands in Claude Code's menu. */
export const SESSION_PLUGIN_NAME = "ccc";
/** `/memtree-view`: print this session's MemTree page link. */
export const MEMTREE_VIEW_COMMAND = "memtree-view";
/**
 * `/memtree-compact [tokens|off]`: compact this session on its next message
 * and keep that compressed history until the budget is reached again.
 */
export const MEMTREE_COMPACT_COMMAND = "memtree-compact";
const UNAVAILABLE_BODY = "Reply with exactly this one line and nothing else: \"MemTree is not reachable right now; try again in a moment.\"\n";
/**
 * Listed in the slash-command menu. The proxy answers each one from the
 * UserPromptSubmit hook and blocks it, so no model turn runs; a body only
 * runs if that hook could not answer (proxy gone).
 */
const SESSION_COMMANDS = {
    [MEMTREE_HELP_COMMAND]: "---\ndescription: List the MemTree commands (/memtree-view, /memtree-compact)\n---\n" + UNAVAILABLE_BODY,
    [MEMTREE_VIEW_COMMAND]: "---\ndescription: Show the link to this session's MemTree page\n---\n" + UNAVAILABLE_BODY,
    [MEMTREE_COMPACT_COMMAND]: "---\ndescription: Compact this session with MemTree now and keep the compressed history (optional token target, or off)\n" +
        "argument-hint: [tokens | off]\n---\n" + UNAVAILABLE_BODY,
};
/**
 * The arguments of a submitted `/<name>` (bare or `/ccc:`-qualified), or
 * undefined when the prompt is not that command.
 */
export function sessionCommandArgs(prompt, name) {
    // Bare `/memtree-view` or this plugin's own `/ccc:memtree-view`; another
    // plugin's command of the same name is not ours to answer.
    const match = new RegExp(`^/(?:${SESSION_PLUGIN_NAME}:)?${name}(?:\\s+(.*))?$`, "s").exec(prompt.trim());
    return match ? (match[1] ?? "").trim() : undefined;
}
export function isMemtreeViewCommand(prompt) {
    return sessionCommandArgs(prompt, MEMTREE_VIEW_COMMAND) !== undefined;
}
/**
 * Relays the SessionStart hook input (stdin) to the proxy's hook URL (argv)
 * and prints the proxy's JSON answer, if any. Always exits 0 with no output
 * on failure: a missing link must never surface as a hook error.
 */
const RESUME_RELAY_SOURCE = `let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", async () => {
  try {
    const res = await fetch(process.argv[2], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: input,
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 200) process.stdout.write(await res.text());
  } catch {}
});
`;
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
/** Evaluated in the proxy's terminal, not the hook relay's piped stdout. */
export function terminalSupportsHyperlinks(env = process.env, stream = process.stdout) {
    if (stream.isTTY !== true || Object.prototype.hasOwnProperty.call(env, "NO_COLOR"))
        return false;
    if (env.TERM === "dumb" || /^(screen|tmux)(-|$)/.test(env.TERM ?? ""))
        return false;
    if (env.TERMINAL_EMULATOR === "JetBrains-JediTerm")
        return true;
    // Terminals with OSC 8 support that identify themselves in the environment.
    if (["ghostty", "WezTerm", "vscode"].includes(env.TERM_PROGRAM ?? ""))
        return true;
    if (env.TERM === "xterm-kitty" || env.TERM === "xterm-ghostty")
        return true;
    if (env.WT_SESSION)
        return true; // Windows Terminal
    if (env.TERM_PROGRAM === "iTerm.app") {
        const match = /^(\d+)\.(\d+)/.exec(env.TERM_PROGRAM_VERSION ?? "");
        return !!match && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 1));
    }
    // Apple Terminal and unknown terminals retain a plain, detectable URL.
    return false;
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
    link = null;
    /** Key of the last link shown; the same key is not repeated. */
    delivered = new Map();
    trailer = null;
    trailerPlacement = "message";
    /** Key of the last trailer shown; a different key is announced as new. */
    constructor(ttlMs = DEFAULT_NOTICE_TTL_MS, now = Date.now, color = terminalSupportsColor()) {
        this.ttlMs = ttlMs;
        this.now = now;
        this.color = color;
    }
    /** Replace stale delivery state when a new main human prompt is submitted. */
    clearForUserRequest() {
        this.pending = null;
    }
    /**
     * Install the per-session link that rides the success line, shown once per
     * change: `<success text> · <link>`. Unlike prefix/suffix notices it is
     * not per-prompt; it describes the conversation's current state whenever a
     * success line is next shown.
     */
    setLink(resolve) {
        this.link = resolve;
    }
    /**
     * The link line for a resumed session, shown by the SessionStart hook
     * before any new turn. Marks the key as shown, so the next trailer under a
     * message renders dim (unchanged) rather than green (new).
     */
    resumeLine(link, sessionId) {
        this.deliveryFor(sessionId).trailer = link.key;
        this.deliveryFor(sessionId).trailerUrl = link.link;
        this.deliveryFor(sessionId).link = link.key;
        return this.linkNotice(this.styleSuccess(LINK_LABEL), link);
    }
    /** Whether the next success line would carry a link not shown before. */
    linkPending(sessionId) {
        return this.resolveLink(sessionId) !== undefined;
    }
    /**
     * Install the trailer: the newest link for the session, shown after every
     * message (or on every Stop), the first time under a new `key` marked as
     * new. Not once-per-key like the success-line link: the point is that the
     * link is always at the bottom of the screen.
     */
    setTrailer(resolve, placement = "message") {
        this.trailer = resolve;
        this.trailerPlacement = placement;
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
        const matched = pending && this.promptMatches(pending, input.prompt_id) ? pending : null;
        const prefix = matched?.prefix;
        const suffix = matched?.suffix;
        // Mark the success link before considering a same-key turn trailer.
        const success = prefix ? this.renderSuccess(prefix, input.session_id) : undefined;
        // Stop is the turn's last hook: the trailer lands here when the turn
        // rendered no message to carry it ("message"), or always ("stop").
        const trailerDue = this.trailerPlacement !== "message" || !this.deliveryFor(input.session_id).shown;
        const trailer = trailerDue ? this.renderTrailer(input.session_id) : undefined;
        this.deliveryFor(input.session_id).shown = false;
        delete this.deliveryFor(input.session_id).successPage;
        if (!prefix && !suffix && trailer === undefined)
            return null;
        if (prefix || suffix)
            this.pending = null;
        markDelivered(prefix);
        markDelivered(suffix);
        const lines = [];
        if (success !== undefined)
            lines.push(success);
        if (suffix)
            lines.push(this.styleWarning(resolveNoticeText(suffix)));
        if (trailer !== undefined)
            lines.push(trailer);
        return {
            systemMessage: lines.join("\n"),
        };
    }
    claimForDisplay(input) {
        const pending = this.freshPending();
        const matched = pending && this.promptMatches(pending, input.prompt_id) ? pending : null;
        const prefix = matched && input.index === 0 ? matched.prefix : undefined;
        const suffix = matched && input.final ? matched.suffix : undefined;
        const trailer = input.final && this.trailerPlacement === "message"
            ? this.renderTrailer(input.session_id)
            : undefined;
        if (trailer !== undefined)
            this.deliveryFor(input.session_id).shown = true;
        if (!prefix && !suffix && trailer === undefined)
            return null;
        // Remove before callbacks or response construction so a reentrant/parallel
        // Stop hook cannot deliver the same notice a second time.
        if (prefix)
            delete matched.prefix;
        if (suffix)
            delete matched.suffix;
        if (matched)
            this.dropIfEmpty(matched);
        markDelivered(prefix);
        markDelivered(suffix);
        let displayContent = input.delta;
        if (prefix) {
            // MessageDisplay exposes text rather than a structured style token.
            // Standard named-color SGR is interpreted by Claude Code on every
            // supported terminal (and stripped cleanly in monochrome/NO_COLOR).
            // Reset foreground only so surrounding renderer styles are preserved.
            const styled = this.renderSuccess(prefix, input.session_id);
            // A blank line under the link keeps the answer from crowding it.
            const gap = styled.includes("\n") && displayContent ? "\n" : "";
            displayContent = `${styled}\n${gap}${displayContent}`;
        }
        if (suffix) {
            const separator = displayContent && !displayContent.endsWith("\n") ? "\n" : "";
            const styled = this.styleWarning(resolveNoticeText(suffix));
            displayContent = `${displayContent}${separator}${styled}`;
        }
        if (trailer !== undefined) {
            // A blank line keeps the trailer apart from the answer above it.
            const separator = displayContent && !displayContent.endsWith("\n") ? "\n" : "";
            displayContent = `${displayContent}${separator}\n${trailer}`;
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
    /**
     * The success line with the session's current MemTree page on its own
     * indented line below it (`✓ … optimized · ~813k → 408k tokens` then
     * `  <link>`), every time the line is shown. The URL stays bare for the
     * terminal's linkifier. Marks the key shown, so the end-of-turn trailer
     * does not repeat the same link.
     */
    renderSuccess(prefix, sessionId) {
        const text = resolveNoticeText(prefix);
        const link = this.currentLink(sessionId);
        if (link === undefined)
            return this.styleSuccess(text);
        this.deliveryFor(sessionId).link = link.key;
        this.deliveryFor(sessionId).successPage = noticePageIdentity(link.link);
        this.deliveryFor(sessionId).trailer = link.key;
        this.deliveryFor(sessionId).trailerUrl = link.link;
        return `${this.styleSuccess(text)}\n  ${link.link}`;
    }
    /** The session's current link, shown or not. Resolver failures never break a hook. */
    currentLink(sessionId) {
        if (!this.link)
            return undefined;
        try {
            const link = this.link(sessionId);
            return link?.link && link.key ? link : undefined;
        }
        catch {
            return undefined;
        }
    }
    /** The link if its key changed since last shown, without marking it. Resolver failures never break a hook. */
    resolveLink(sessionId) {
        if (!this.link)
            return undefined;
        let link;
        try {
            link = this.link(sessionId);
        }
        catch {
            return undefined;
        }
        return link?.link && link.key && link.key !== this.deliveryFor(sessionId).link ? link : undefined;
    }
    /**
     * The trailer line for this session, or undefined when there is no link.
     * The first time a key is seen the label says so in green; afterwards the
     * label is dim. The URL stays bare either way (linkifier-safe). Rendering
     * marks the key as seen. Resolver failures never break a hook.
     */
    renderTrailer(sessionId) {
        if (!this.trailer)
            return undefined;
        let link;
        try {
            link = this.trailer(sessionId);
        }
        catch {
            return undefined;
        }
        if (!link?.link || !link.key)
            return undefined;
        const delivered = this.deliveryFor(sessionId);
        if (this.trailerPlacement === "turn" && delivered.successPage === noticePageIdentity(link.link))
            return undefined;
        const isNew = link.key !== delivered.trailer && link.link !== delivered.trailerUrl;
        // "turn": one line per user turn, and only when the index changed.
        if (this.trailerPlacement === "turn" && !isNew)
            return undefined;
        this.deliveryFor(sessionId).trailer = link.key;
        this.deliveryFor(sessionId).trailerUrl = link.link;
        const label = isNew ? this.styleSuccess(LINK_LABEL) : this.styleDim(LINK_LABEL);
        return this.linkNotice(label, link);
    }
    /** The link notice with its note dim. */
    linkNotice(label, link) {
        return linkLines(label, link.link, link.note && this.styleDim(link.note));
    }
    styleDim(text) {
        return this.color ? `${ANSI_DIM}${text}${ANSI_NORMAL_INTENSITY}` : text;
    }
    deliveryFor(sessionId) {
        const state = this.delivered.get(sessionId) ?? { shown: false };
        this.delivered.delete(sessionId);
        this.delivered.set(sessionId, state);
        if (this.delivered.size > 64)
            this.delivered.delete(this.delivered.keys().next().value);
        return state;
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
/** Compare the short and pinned spellings only within a turn's success/Stop pair. */
function noticePageIdentity(link) {
    try {
        const url = new URL(link);
        const match = /^\/(?:m|usage\/memtree)\/([0-9a-f]{12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-v[13]-(?:own|served))?$/.exec(url.pathname);
        if (match)
            return `${url.origin}/${match[1].replace(/-/g, "").slice(0, 12)}`;
    }
    catch { /* Non-page links compare literally. */ }
    return link;
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
    if (input.hook_event_name === "SessionStart") {
        if (input.source !== undefined && typeof input.source !== "string")
            return null;
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
    const commandsDir = path.join(dir, "commands");
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.mkdirSync(hooksDir, { recursive: true });
    // Listed in the slash-command menu; the proxy answers it from the
    // UserPromptSubmit hook (see MEMTREE_VIEW_COMMAND) before any model turn.
    // The body only runs if that hook could not answer (proxy gone).
    fs.mkdirSync(commandsDir, { recursive: true });
    for (const [name, source] of Object.entries(SESSION_COMMANDS)) {
        fs.writeFileSync(path.join(commandsDir, `${name}.md`), source, { mode: 0o600 });
    }
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
            ...(hooks.SessionStart ?? []),
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
    if (opts.resumeLink) {
        const relay = path.join(hooksDir, RESUME_RELAY_FILE);
        fs.writeFileSync(relay, RESUME_RELAY_SOURCE, { mode: 0o600 });
        hooks.SessionStart = [
            ...(hooks.SessionStart ?? []),
            {
                // Every session start that could already have a page. A fresh or
                // cleared session has none yet, so in practice this answers resumes;
                // compaction continues the same session and needs no line.
                matcher: "startup|resume|clear|fork",
                hooks: [
                    {
                        type: "command",
                        command: [process.execPath, relay, hookUrl]
                            .map(singleQuoteForShell)
                            .join(" "),
                        timeout: 5,
                    },
                ],
            },
        ];
    }
    fs.writeFileSync(path.join(manifestDir, "plugin.json"), JSON.stringify({
        // Claude Code lists plugin commands as `/<name>:<command>`, so this
        // short name is what users see: `/ccc:memtree`, `/ccc:memtree-view`, …
        name: SESSION_PLUGIN_NAME,
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