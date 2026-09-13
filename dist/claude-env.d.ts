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
 * `CCC_AUTO_COMPACT=1` is an escape hatch: remove ccc's override and let the
 * user's native Claude Code setting decide whether auto-compaction is enabled.
 */
export declare function claudeChildEnv(parentEnv: NodeJS.ProcessEnv, anthropicBaseUrl: string): NodeJS.ProcessEnv;
/**
 * Keep the proxy's MemTree budget in lockstep with Claude Code's own context
 * accounting. This is the documented escape hatch for forcing native-1M
 * models back to their legacy 200k window.
 */
export declare function claudeNativeOneMillionContextEnabled(parentEnv: NodeJS.ProcessEnv): boolean;
//# sourceMappingURL=claude-env.d.ts.map