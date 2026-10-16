/**
 * Allowlist for client diagnostics (polychat plans/2026-10-16_PLAN_ccc_client_diagnostics.md).
 *
 * Every event is rebuilt here from named fields only, each checked against an enum, a tight
 * pattern or an integer range; anything else is dropped before it is queued. The server
 * (polychat/ccc_diagnostics.py) enforces the same list again. There is no free-text field:
 * errors travel as codes, because a Node error message can quote its input (JSON.parse
 * does) and so carry conversation content.
 */
export const DIAGNOSTICS_SCHEMA = 1;
/** A validator's "not allowed" answer. */
const DROP = Symbol("drop");
/** Three parts only: a fourth (Claude Code's build suffix) would let an IPv4 address through. */
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-(?:alpha|beta|rc|next|canary)(?:\.\d{1,4})?)?$/;
/**
 * Error codes and class names are fixed vocabularies; anything else is sent as "other"
 * (errnoName / errorClassName). A shape check would let a project or customer name through.
 */
export const ERRNOS = [
    "EACCES", "EPERM", "ENOENT", "ENOTDIR", "EISDIR", "EEXIST", "ENOSPC", "EROFS", "EMFILE",
    "EBUSY", "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND",
    "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "EADDRINUSE", "ERR_INVALID_URL",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN",
    "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID", "other",
];
export const SIGNALS = [
    "SIGINT", "SIGTERM", "SIGKILL", "SIGHUP", "SIGQUIT", "SIGABRT", "SIGSEGV", "SIGBUS",
    "SIGPIPE", "SIGUSR1", "SIGUSR2", "SIGTSTP", "SIGILL", "SIGFPE", "SIGTRAP", "SIGSYS",
    "SIGXCPU", "SIGXFSZ", "SIGALRM", "other",
];
/** A signal name from the fixed list, else "other"; undefined when there is none. */
export function signalName(value) {
    if (typeof value !== "string")
        return undefined;
    return SIGNALS.includes(value) ? value : "other";
}
export const ERROR_NAMES = [
    "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AbortError",
    "TimeoutError", "SystemError", "other",
];
/** A Node errno code from the fixed list, else "other"; undefined when there is none. */
export function errnoName(value) {
    if (typeof value !== "string")
        return undefined;
    return ERRNOS.includes(value) ? value : "other";
}
/** An error class name from the fixed list, else "other"; undefined when there is none. */
export function errorClassName(value) {
    if (typeof value !== "string")
        return undefined;
    return ERROR_NAMES.includes(value) ? value : "other";
}
export const ERROR_CODES = [
    "startup_failed", "spawn_failed", "proxy_start_failed", "config_write_failed",
    "status_probe_failed", "update_check_failed", "plugin_failed", "mcp_config_failed",
];
export const INSTALL_METHODS = [
    "npm-global", "npm-link", "git-checkout", "npx", "local", "pnpm", "yarn", "bun", "volta",
    "not-writable", "root", "unsupported-platform", "unknown",
];
export const TERMINALS = [
    "Apple_Terminal", "iTerm.app", "vscode", "WezTerm", "ghostty", "WarpTerminal", "tmux",
    "Hyper", "Tabby", "alacritty", "kitty", "cursor", "zed", "JetBrains-JediTerm", "rio",
    "Windows_Terminal", "mintty", "konsole", "gnome-terminal", "none", "other",
];
export const TURN_TYPES = [
    "first-user", "tool", "tool-memory", "tool-prefix", "tool-recompressed",
    "followup-compressed", "followup-prefix", "followup-noop", "followup-empty-memory",
    "followup-no-flatten", "followup-degraded", "fork-memory", "side-request", "foreign",
    "followup-client-closed", "unparseable", "other",
];
/** The event, rebuilt from allowed fields only; null when its name is not allowed. */
export function sanitizeEvent(name, fields, t) {
    if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(EVENT_FIELDS, name)) {
        return null;
    }
    const allowed = EVENT_FIELDS[name];
    return { ...sanitizeFields(fields, allowed), name, t: Math.floor(t) };
}
export function sanitizeContext(fields) {
    return sanitizeFields(fields, CONTEXT_FIELDS);
}
export function sanitizeFields(fields, allowed) {
    const out = {};
    for (const [key, check] of Object.entries(allowed)) {
        if (!Object.prototype.hasOwnProperty.call(fields, key))
            continue;
        const value = check(fields[key]);
        if (value !== DROP && value !== undefined && value !== null) {
            out[key] = value;
        }
    }
    return out;
}
/** `2.1.301.241` → `2.1.301`; anything not version-shaped → undefined. */
export function threePartVersion(raw) {
    if (typeof raw !== "string")
        return undefined;
    const m = /^(\d{1,4}\.\d{1,4}\.\d{1,6})/.exec(raw.trim());
    return m ? m[1] : undefined;
}
function oneOf(values) {
    const set = new Set(values);
    return (v) => (typeof v === "string" && set.has(v) ? v : DROP);
}
function matching(re, maxLength = 40) {
    return (v) => (typeof v === "string" && v.length <= maxLength && re.test(v) ? v : DROP);
}
function integer(lo, hi) {
    return (v) => {
        if (typeof v !== "number" || !Number.isFinite(v))
            return DROP;
        return Math.max(lo, Math.min(hi, Math.round(v)));
    };
}
const bool = (v) => (typeof v === "boolean" ? v : DROP);
const VERSION = matching(VERSION_RE);
const STATUS = integer(0, 999);
const MS = integer(0, 24 * 3600 * 1000);
const KB = integer(0, 1_000_000);
export const CONTEXT_FIELDS = {
    ccc_version: VERSION,
    cc_version: VERSION,
    node: VERSION,
    install_method: oneOf(INSTALL_METHODS),
    os: oneOf(["darwin", "linux", "win32", "freebsd", "openbsd", "sunos", "aix", "android",
        "other"]),
    os_release: matching(/^\d{1,4}(?:\.\d{1,6}){0,2}$/),
    arch: oneOf(["arm64", "x64", "ia32", "arm", "ppc64", "s390x", "riscv64", "loong64",
        "other"]),
    terminal: oneOf(TERMINALS),
    locale: matching(/^(?:[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?|other)$/, 16),
    wsl: bool,
    interactive: bool,
    mode: oneOf(["production", "staging", "local"]),
};
export const EVENT_FIELDS = {
    first_run: {},
    sign_in_prompt: {},
    key_saved: {},
    key_status: { result: oneOf(["ok", "invalid", "payment_required", "unknown"]), status: STATUS },
    payment_gate: { choice: oneOf(["subscribe", "continue", "quit", "paid", "still_unpaid"]) },
    session_start: { source: oneOf(["startup", "resume", "clear", "compact", "other"]) },
    first_request: { status: STATUS, turn_type: oneOf(TURN_TYPES), ttfb_ms: MS, total_ms: MS,
        request_kb: KB },
    first_turn: { status: STATUS, turn_type: oneOf(TURN_TYPES), ttfb_ms: MS, total_ms: MS,
        request_kb: KB },
    upstream_error: { status: STATUS, turn_type: oneOf(TURN_TYPES), total_ms: MS,
        request_kb: KB },
    memtree_error: { status: STATUS, index_only: bool, ms: MS, request_kb: KB },
    compress_timeout: { ms: MS, request_kb: KB },
    refusal: { status: STATUS, input_ktokens: KB, budget_ktokens: KB, attempt: integer(0, 1000) },
    paused_notice: { trigger: oneOf(["turn", "resume"]) },
    update_hint: { latest: VERSION },
    auto_update: { result: oneOf(["started", "locked", "not-planned", "spawn-failed", "skipped"]) },
    claude_exit: { code: integer(-1000, 1000), signal: oneOf(SIGNALS) },
    claude_missing: {},
    error: { code: oneOf(ERROR_CODES), errno: oneOf(ERRNOS),
        error_name: oneOf(ERROR_NAMES) },
};
//# sourceMappingURL=diagnostics-schema.js.map