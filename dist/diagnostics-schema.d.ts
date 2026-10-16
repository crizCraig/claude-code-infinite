/**
 * Allowlist for client diagnostics (polychat plans/2026-10-16_PLAN_ccc_client_diagnostics.md).
 *
 * Every event is rebuilt here from named fields only, each checked against an enum, a tight
 * pattern or an integer range; anything else is dropped before it is queued. The server
 * (polychat/ccc_diagnostics.py) enforces the same list again. There is no free-text field:
 * errors travel as codes, because a Node error message can quote its input (JSON.parse
 * does) and so carry conversation content.
 */
export declare const DIAGNOSTICS_SCHEMA = 1;
type Validator = (value: unknown) => unknown;
export declare const ERROR_CODES: readonly ["startup_failed", "spawn_failed", "proxy_start_failed", "config_write_failed", "status_probe_failed", "update_check_failed", "plugin_failed", "mcp_config_failed"];
export type DiagnosticsErrorCode = (typeof ERROR_CODES)[number];
export declare const INSTALL_METHODS: readonly ["npm-global", "npm-link", "git-checkout", "npx", "local", "pnpm", "yarn", "bun", "volta", "not-writable", "root", "unsupported-platform", "unknown"];
export declare const TERMINALS: readonly ["Apple_Terminal", "iTerm.app", "vscode", "WezTerm", "ghostty", "WarpTerminal", "tmux", "Hyper", "Tabby", "alacritty", "kitty", "cursor", "zed", "JetBrains-JediTerm", "rio", "Windows_Terminal", "mintty", "konsole", "gnome-terminal", "none", "other"];
export declare const TURN_TYPES: readonly ["first-user", "tool", "tool-memory", "tool-prefix", "tool-recompressed", "followup-compressed", "followup-prefix", "followup-noop", "followup-empty-memory", "followup-no-flatten", "followup-degraded", "fork-memory", "side-request", "foreign", "followup-client-closed", "unparseable", "other"];
export type DiagnosticsFields = Record<string, string | number | boolean>;
export interface DiagnosticsEvent extends DiagnosticsFields {
    name: string;
    t: number;
}
/** The event, rebuilt from allowed fields only; null when its name is not allowed. */
export declare function sanitizeEvent(name: string, fields: Record<string, unknown>, t: number): DiagnosticsEvent | null;
export declare function sanitizeContext(fields: Record<string, unknown>): DiagnosticsFields;
export declare function sanitizeFields(fields: Record<string, unknown>, allowed: Record<string, Validator>): DiagnosticsFields;
/** `2.1.301.241` → `2.1.301`; anything not version-shaped → undefined. */
export declare function threePartVersion(raw: unknown): string | undefined;
export declare const CONTEXT_FIELDS: Record<string, Validator>;
export declare const EVENT_FIELDS: Record<string, Record<string, Validator>>;
export {};
//# sourceMappingURL=diagnostics-schema.d.ts.map