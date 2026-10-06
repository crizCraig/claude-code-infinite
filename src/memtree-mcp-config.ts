/**
 * Registering the `memtree` MCP server (memtree-mcp.ts) with Claude Code, and
 * telling whether it is registered, which decides the `x-memtree-tools`
 * header on MemTree compress calls: MemTree then adds a short how-to naming
 * the tools to the memory it returns, so it must never be sent when the tools
 * are absent.
 *
 * - Interactive ccc sessions: ccc writes a one-server config to a temp dir
 *   and passes `--mcp-config=<file>`. `--mcp-config` (unlike a plugin's
 *   `.mcp.json`, whose tools Claude Code would name `mcp__plugin_ccc_…`) keeps
 *   the tool names `mcp__memtree__*` and still loads under a user's
 *   `--strict-mcp-config`. The `=` form matters: `--mcp-config` is variadic,
 *   and a following positional prompt would otherwise be read as a config.
 *   The tools are read-only views of the user's own session, so they are
 *   pre-allowed with `--allowedTools=` as well. `CCC_MEMTREE_MCP=0` turns this
 *   off.
 * - Print (`-p`) and non-TTY runs get nothing automatically (their output and
 *   tool set stay vanilla). A caller that wants the tools passes its own
 *   `--mcp-config` naming a server `memtree` run by `ccc memtree-mcp` (or
 *   dist/memtree-mcp.js); ccc detects it and sends the header.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MEMTREE_MCP_SERVER_NAME, MEMTREE_TOOL_NAMES } from "./memtree-mcp.js";

/** `x-memtree-tools` value. */
export const MEMTREE_TOOLS_HEADER_VALUE = MEMTREE_TOOL_NAMES.join(",");
/** Claude Code's names for the tools, for `--allowedTools`. */
export const MEMTREE_ALLOWED_TOOLS = MEMTREE_TOOL_NAMES.map(
  (tool) => `mcp__${MEMTREE_MCP_SERVER_NAME}__${tool}`
);
export const MEMTREE_MCP_SCRIPT = fileURLToPath(new URL("./memtree-mcp.js", import.meta.url));

export function memtreeMcpEnabledByEnv(env: NodeJS.ProcessEnv): boolean {
  return env.CCC_MEMTREE_MCP !== "0";
}

/** The `--mcp-config` JSON for this ccc's server, bound to its proxy. */
export function memtreeMcpConfig(proxyUrl: string): object {
  return {
    mcpServers: {
      [MEMTREE_MCP_SERVER_NAME]: {
        type: "stdio",
        command: process.execPath,
        args: [MEMTREE_MCP_SCRIPT],
        env: { CCC_MEMTREE_PROXY: proxyUrl },
      },
    },
  };
}

export interface MemtreeMcpConfigFile {
  path: string;
  close(): void;
}

export function writeMemtreeMcpConfig(
  proxyUrl: string,
  tempRoot: string = os.tmpdir()
): MemtreeMcpConfigFile {
  const dir = fs.mkdtempSync(path.join(tempRoot, "ccc-memtree-mcp-"));
  const file = path.join(dir, "mcp.json");
  fs.writeFileSync(file, JSON.stringify(memtreeMcpConfig(proxyUrl)), { mode: 0o600 });
  let closed = false;
  return {
    path: file,
    close() {
      if (closed) return;
      closed = true;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Prepend the options; `=` forms so no variadic option swallows user argv. */
export function withMemtreeMcpArgs(args: readonly string[], configPath: string): string[] {
  return [
    `--mcp-config=${configPath}`,
    `--allowedTools=${MEMTREE_ALLOWED_TOOLS.join(",")}`,
    ...args,
  ];
}

/**
 * The `--mcp-config` values in Claude's argv (before `--`): each is a file
 * path or an inline JSON string. Handles `--mcp-config a b` (variadic, up to
 * the next option) and `--mcp-config=a`.
 */
export function mcpConfigArgs(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg.startsWith("--mcp-config=")) {
      values.push(arg.slice("--mcp-config=".length));
      continue;
    }
    if (arg !== "--mcp-config") continue;
    while (i + 1 < args.length && !args[i + 1].startsWith("-")) values.push(args[++i]);
  }
  return values;
}

/**
 * Whether Claude's argv already configures ccc's `memtree` server: a server
 * named `memtree` whose command line runs `memtree-mcp` (`ccc memtree-mcp` or
 * dist/memtree-mcp.js). Unreadable or malformed configs count as no.
 */
export function argsConfigureMemtreeMcp(
  args: readonly string[],
  cwd: string = process.cwd()
): boolean {
  for (const value of mcpConfigArgs(args)) {
    let parsed: unknown;
    try {
      const text = value.trim().startsWith("{")
        ? value
        : fs.readFileSync(path.resolve(cwd, value), "utf-8");
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const server = (parsed as { mcpServers?: Record<string, unknown> })?.mcpServers?.[
      MEMTREE_MCP_SERVER_NAME
    ] as { command?: unknown; args?: unknown } | undefined;
    if (!server || typeof server !== "object") continue;
    const commandLine = [server.command, ...(Array.isArray(server.args) ? server.args : [])]
      .filter((part) => typeof part === "string")
      .join(" ");
    if (/memtree-mcp/.test(commandLine)) return true;
  }
  return false;
}
