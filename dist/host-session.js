/**
 * Names shared by the pieces that tell ccc's memtree MCP server which session its
 * Claude Code process is on (proxy.ts: `/memtree/host-session`; memtree-mcp.ts:
 * refreshHostSession; hooks.ts: the SessionStart relay; memtree-mcp-config.ts).
 */
/** MCP server env: the secret it sends to `/memtree/host-session` (from ccc's MCP config). */
export const HOST_TOKEN_ENV = "CCC_MEMTREE_HOST_TOKEN";
/** Request header carrying that secret. */
export const HOST_TOKEN_HEADER = "x-ccc-host-token";
/** SessionStart relay header: the pid of the Claude Code process that ran the hook. */
export const CLAUDE_PID_HEADER = "x-ccc-claude-pid";
//# sourceMappingURL=host-session.js.map