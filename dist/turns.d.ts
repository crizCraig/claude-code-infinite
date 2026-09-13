/**
 * Turn detection and message-shaping helpers, ported from the polychat server
 * (memory/preserve_last_user_message.py, memory/v2/consume.py,
 * llm_api/extract_text.py) per plans/2026-06-09_PLAN_local_proxy_app.md.
 *
 * Audit notes vs the server heuristic (plan "Turn detection nuances"):
 * - A message containing ANY tool_result block is treated as a tool turn, even
 *   with trailing text blocks (Claude Code appends system-reminder text blocks
 *   after tool_results; the server's all-blocks-are-tool_results check counted
 *   those as user turns).
 * - Text is checked after stripping <system-reminder> tags, so standalone
 *   system-reminder messages are not user turns.
 * - The "user stepped away" recap prompt (plain text, no tag) intentionally
 *   counts as a real user turn for compression, but is separately recognized
 *   so no user-facing MemTree notice is queued for that hidden request.
 */
export type Message = Record<string, any>;
/** Distinctive stable prefix of Claude Code's hidden away-summary prompt. */
export declare const AWAY_SUMMARY_PROMPT_PREFIX = "The user stepped away and is coming back. Recap in under 40 words";
export declare function stripSystemReminderText(text: string): string;
/** True only for Claude Code's user wrapper carrying one or more tool results. */
export declare function isToolResultUserMessage(message: Message | undefined | null): boolean;
/** True if this is a real user instruction (not a tool-result wrapper or synthetic reminder). */
export declare function isNonToolUserMessage(message: Message | undefined | null): boolean;
/** True only for Claude Code's hidden away-summary user request. */
export declare function isAwaySummaryUserMessage(message: Message | undefined | null): boolean;
/** Concatenate plain text fields from a user message for hook correlation. */
export declare function userMessageText(message: Message | undefined | null): string;
/**
 * Claude Code may append ambient role=system context after the human message.
 * Turn classification is based on the last conversation message, not that
 * trailing metadata.
 */
export declare function lastNonSystemMessage(messages: Message[]): Message | undefined;
/**
 * True for Claude Code's local `!command` replay shape. These commands do not
 * consistently emit UserPromptSubmit, but their stdout is followed by a real
 * main-thread completion (and therefore can legitimately own a display-only
 * MemTree notice). Keep the match strict so arbitrary unarmed API traffic does
 * not acquire notice ownership.
 */
export declare function isLocalBashCommandTurn(messages: Message[]): boolean;
/**
 * True if any message before the effective last non-system message is a real
 * user input. Distinguishes the
 * first user turn (nothing indexed yet — don't block on compression) from
 * followup user turns (plans/2026-07-05_PLAN_first_user_turn_nonblocking.md).
 * Synthetic reminder messages and tool_result wrappers don't count, via the
 * same audited isNonToolUserMessage heuristic.
 */
export declare function hasEarlierNonToolUserMessage(messages: Message[]): boolean;
/**
 * Remove Claude Code <system-reminder> snippets before sending messages to the
 * indexing endpoint (mirrors server strip_cc_system_reminders — reminders churn
 * on /resume and would cause indexing inconsistencies).
 */
export declare function stripCcSystemReminders(messages: Message[]): Message[];
/**
 * Build the message list sent to /v1/context_memory: the Anthropic top-level
 * `system` param becomes a leading system-role message (mirrors cc_api.py).
 */
export declare function messagesWithSystem(messages: Message[], system: string | any[] | undefined | null): Message[];
export declare function contextLimitForModel(model: string | undefined, anthropicBeta?: string, nativeOneMillionContext?: boolean): number;
/**
 * Model name to report to the MemTree server: re-attach the `[1m]` suffix
 * when the session runs with 1M context but the wire model name is plain
 * (either because Claude Code moved the suffix into the beta header or because
 * the model is natively 1M). The server resolves `<model>[1m]` aliases and logs
 * the requested model verbatim, so this keeps its budget telemetry
 * self-explanatory about the context variant.
 */
export declare function modelForMemtree(model: string | undefined, contextLimit: number): string | undefined;
//# sourceMappingURL=turns.d.ts.map