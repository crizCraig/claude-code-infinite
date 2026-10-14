/**
 * The memtree tools' schemas for sessions whose transcript latched them as
 * deferred.
 *
 * ccc's `--mcp-config` sets `alwaysLoad: true` and each tool carries
 * `_meta["anthropic/alwaysLoad"]`, and Claude Code (2.1.296) honours both for
 * a session that starts with them: the schemas are in `tools` from turn 1,
 * and stay there on --resume. But a resumed session keeps the tool placement
 * its own transcript recorded, to protect the prompt cache: a session that
 * began while the memtree tools were deferred (ccc before 1.0.18) is resumed
 * with them still deferred, whatever the config now says, and no setting
 * overrides that record (a server's or tool's alwaysLoad only decides a new
 * placement; Claude Code's non-deferrable list is server-controlled). The
 * model then has to load them through ToolSearch first.
 *
 * So the proxy adds the four definitions, exactly as Claude Code lists them
 * inline (same name, description and input_schema), when a request has tool
 * search and names the memtree tools but sends no schema for them. Claude Code
 * runs a call to a deferred tool whose input validates, so the model can call
 * them directly. Only ccc's own server is covered (the caller checks it is
 * configured), and nothing changes for requests that already carry them.
 */
import { MEMTREE_MCP_SERVER_NAME, MEMTREE_TOOLS } from "./memtree-mcp.js";

const TOOL_SEARCH = "ToolSearch";
const TOOL_PREFIX = `mcp__${MEMTREE_MCP_SERVER_NAME}__`;

/**
 * Append the memtree tool definitions the request lacks; returns the names
 * added (none when the request is left as it was). Mutates `body.tools`.
 */
export function withMemtreeToolDefinitions(body: Record<string, any>): string[] {
  const tools = body.tools;
  if (!Array.isArray(tools) || !tools.some((tool) => tool?.name === TOOL_SEARCH)) return [];
  if (!mentionsMemtreeTools(body)) return [];
  const present = new Set([
    ...tools.map((tool) => tool?.name),
    ...toolsAddedByValue(body.messages),
  ]);
  const eager = tools.some((tool) => tool?.eager_input_streaming === true);
  const added = MEMTREE_TOOLS
    .filter((tool) => !present.has(`${TOOL_PREFIX}${tool.name}`))
    .map((tool) => ({
      name: `${TOOL_PREFIX}${tool.name}`,
      description: tool.description,
      input_schema: tool.inputSchema,
      ...(eager ? { eager_input_streaming: true } : {}),
    }));
  tools.push(...added);
  return added.map((tool) => tool.name);
}

/** Whether the request names a memtree tool (the deferred list, or a memory how-to). */
function mentionsMemtreeTools(body: Record<string, any>): boolean {
  return JSON.stringify([body.system ?? null, body.messages ?? null]).includes(TOOL_PREFIX);
}

/** Names of tools Claude Code already sent by value inside messages (`tool_addition`). */
function toolsAddedByValue(messages: unknown): string[] {
  const names: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const node = value as Record<string, any>;
    const name = node.type === "tool_addition" ? node.tool?.definition?.name : undefined;
    if (typeof name === "string") names.push(name);
    for (const child of Object.values(node)) visit(child);
  };
  visit(messages);
  return names;
}
