/**
 * The line ccc prints after Claude Code exits, under Claude Code's own
 * "Resume this session with: claude --resume <id>": resuming with plain
 * `claude` would skip MemTree, so name the ccc form too.
 */
/** Claude Code session ids are UUIDs; anything else is not safe to print. */
const RESUMABLE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// The startup banner's colours (cli-main.ts printBanner): MemTree green, ccc orange.
const LABEL_COLOR = "\x1b[38;5;48m";
const COMMAND_COLOR = "\x1b[1;38;5;209m";
const RESET = "\x1b[0m";
/** What ccc prints once Claude Code has exited, if anything. */
export function exitResumeHint(opts) {
    if (!opts.interactive)
        return undefined;
    return resumeHintText({
        sessionId: opts.sessionId,
        envPrefix: opts.mode === "production" ? undefined : opts.mode,
        color: opts.color,
    });
}
/** The hint to print, or undefined when there is no session id to offer. */
export function resumeHintText(opts) {
    if (!isResumableSessionId(opts.sessionId))
        return undefined;
    const command = ["ccc", opts.envPrefix, "--resume", opts.sessionId]
        .filter((part) => part !== undefined && part !== "")
        .join(" ");
    const paint = (code, text) => (opts.color ? `${code}${text}${RESET}` : text);
    return `\n${paint(LABEL_COLOR, "Resume with MemTree:")}\n${paint(COMMAND_COLOR, command)}\n`;
}
/** Whether `id` looks like a Claude Code session id (safe for a terminal and a shell). */
export function isResumableSessionId(id) {
    return typeof id === "string" && RESUMABLE_SESSION_ID.test(id);
}
//# sourceMappingURL=resume-hint.js.map