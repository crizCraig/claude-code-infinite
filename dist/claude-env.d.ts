/**
 * Environment for the Claude Code child process.
 *
 * MemTree replaces Claude Code's built-in automatic compaction, so ccc disables
 * only auto-compaction by default. Manual `/compact` remains available because
 * Claude Code controls it with a separate setting.
 *
 * Claude Code normally treats a custom ANTHROPIC_BASE_URL as a third-party
 * gateway. That suppresses native model capabilities it cannot verify through
 * an arbitrary gateway, including the native 1M windows on current models.
 * ccc's loopback server is a transparent relay to api.anthropic.com, so mark
 * that base URL as first-party and preserve vanilla model/context behavior.
 *
 * Claude Code 2.1.219 also presents a "Resume from summary" option (which
 * internally runs `/compact`) when a resumed session exceeds a fixed
 * 100k-token threshold, regardless of its actual context window or
 * DISABLE_AUTO_COMPACT. Suppress that ccc-inappropriate recommendation with an
 * effectively unreachable finite threshold; manual `/compact` remains available.
 *
 * With auto-compaction off, Claude Code still refuses a request itself once
 * its own estimate (last reported usage plus the new messages) reaches the
 * window minus 23k (977k on a 1M window; 2.1.302, measured) and never sends
 * it: "Prompt is too long", and every later message is refused the same way.
 * MemTree compresses at a budget near the window (900k), so one large tool
 * round could otherwise strand a session there before ccc sees the request.
 * CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE lifts that refusal: the request reaches
 * the proxy, which compresses it mid-turn or, failing that, refuses it with
 * its own bounded retry/400. A value the user already exported is kept.
 *
 * `CCC_AUTO_COMPACT=1` is an escape hatch: remove ccc's override and let the
 * user's native Claude Code setting decide whether auto-compaction is enabled
 * (Claude Code's own limits then apply unchanged).
 */
/** Claude Code's local refusal limit under ccc: effectively never reached. */
export declare const UNREACHABLE_BLOCKING_LIMIT = "1000000000";
export declare function claudeChildEnv(parentEnv: NodeJS.ProcessEnv, anthropicBaseUrl: string): NodeJS.ProcessEnv;
/**
 * Keep the proxy's MemTree budget in lockstep with Claude Code's own context
 * accounting. This is the documented escape hatch for forcing native-1M
 * models back to their legacy 200k window.
 */
export declare function claudeNativeOneMillionContextEnabled(parentEnv: NodeJS.ProcessEnv): boolean;
//# sourceMappingURL=claude-env.d.ts.map