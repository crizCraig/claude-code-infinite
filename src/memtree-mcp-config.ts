/**
 * Registering the `memtree` MCP server (memtree-mcp.ts) with Claude Code, and
 * telling whether it is registered, which decides the `x-memtree-tools`
 * header on MemTree compress calls: MemTree then adds a short how-to naming
 * the tools to the memory it returns, so it must never be sent when the tools
 * are absent.
 *
 * - Every ccc session, interactive or print (`-p`) / non-TTY: ccc writes a
 *   one-server config to a temp dir and passes `--mcp-config=<file>`.
 *   `--mcp-config` (unlike a plugin's `.mcp.json`, whose tools Claude Code
 *   would name `mcp__plugin_ccc_…`) keeps the tool names `mcp__memtree__*` and
 *   still loads under a user's `--strict-mcp-config`. The `=` form matters:
 *   `--mcp-config` is variadic, and a following positional prompt would
 *   otherwise be read as a config. The tools are read-only views of the
 *   user's own sessions, so they are pre-allowed with `--allowedTools=` as
 *   well: Claude Code adds repeated `--allowedTools` lists together, so a
 *   caller's own list is kept and only these tools are added. The server sets
 *   Claude Code's `alwaysLoad: true`, so its tools are in the prompt from the
 *   first turn (and after --resume) instead of deferred behind tool search;
 *   this applies to this server only, not the user's other MCP servers.
 *   Claude Code also waits (up to its 5s connect timeout) for the server
 *   before that turn; it is a local Node process, so that is milliseconds.
 *   The server writes only to its own stdio pipe, so `-p` output (text, json,
 *   stream-json) is unchanged apart from what the model does with the tools.
 * - The caller's choices win (planMemtreeMcp): `CCC_MEMTREE_MCP=0` turns it
 *   off; a caller's own `--mcp-config` server named `memtree` (or a config
 *   ccc cannot read, which might define one) is kept and ccc adds and
 *   pre-allows nothing (if it runs proxy-mode `ccc memtree-mcp` the header is
 *   still sent; if it runs `--direct`, which has no session "current" tree,
 *   the header is omitted so compression never advertises current-tree reads);
 *   tools named by `--disallowedTools` (a tool, `mcp__memtree`,
 *   or a `*` pattern) are neither pre-allowed nor named in the header, and
 *   with all of them disallowed ccc registers nothing. Claude Code applies a
 *   deny over an allow in any case.
 */
import { HOST_TOKEN_ENV } from "./host-session.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import type { CccEnvironment } from "./cli-args.js";
import {
  MEMTREE_MCP_SERVER_NAME,
  MEMTREE_TOOL_NAMES,
  PROXY_VERSION_ENV,
} from "./memtree-mcp.js";
import { CLIENT_VERSION } from "./memtree.js";

/** `x-memtree-tools` value. */
export const MEMTREE_TOOLS_HEADER_VALUE = MEMTREE_TOOL_NAMES.join(",");
/** Claude Code's names for the tools, for `--allowedTools`. */
export const MEMTREE_ALLOWED_TOOLS = MEMTREE_TOOL_NAMES.map(memtreeToolName);
export const MEMTREE_MCP_SCRIPT = fileURLToPath(new URL("./memtree-mcp.js", import.meta.url));

export function memtreeMcpEnabledByEnv(env: NodeJS.ProcessEnv): boolean {
  return env.CCC_MEMTREE_MCP !== "0";
}

/** Prefer a stable installation symlink only if it identifies the running binary.
 * Never obtain the registered command from PATH or the working directory. */
export function directMcpNodePath(realNode: string): string {
  if (process.platform === "win32") return realNode;
  const candidates: string[] = [];
  const brew = /^(\/.*)\/Cellar\/(node(?:@[\d.]+)?)\/[^/]+\/bin\/node$/.exec(realNode);
  if (brew) {
    candidates.push(path.join(brew[1], "bin/node"), path.join(brew[1], "opt", brew[2], "bin/node"));
  }
  const nvm = /^(\/.*)\/versions\/node\/[^/]+\/bin\/node$/.exec(realNode);
  if (nvm) candidates.push(path.join(nvm[1], "current/bin/node"));
  candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node");
  for (const candidate of candidates) {
    try {
      if (fs.realpathSync(candidate) === realNode) return candidate;
    } catch {
      // This installation need not have any of these links.
    }
  }
  return realNode;
}

/** TOML literal strings preserve Windows backslashes. A quote or control
 * character requires an escaped basic string instead. */
function tomlString(value: string): string {
  if (/['\x00-\x1f\x7f]/.test(value)) return JSON.stringify(value).replaceAll("\x7f", "\\u007f");
  return `'${value}'`;
}

export function formatDirectMcpConfig(
  format: "codex" | "json", command: string, cli: string, mode: "production" | "staging"
): string {
  const args = [cli, "memtree-mcp", "--direct"];
  if (mode === "staging") args.push("--env", mode);
  if (format === "json") {
    const server = { command, args, env: { NODE_OPTIONS: "" } };
    return JSON.stringify({ mcpServers: { [MEMTREE_MCP_SERVER_NAME]: server } }, null, 2);
  }
  return [
    `[mcp_servers.${MEMTREE_MCP_SERVER_NAME}]`,
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(", ")}]`,
    'env = { NODE_OPTIONS = "" }',
  ].join("\n");
}

export function printDirectMcpConfig(args: string[], defaultEnv: CccEnvironment): number {
  let values;
  try {
    ({ values } = parseArgs({ args, options: { format: { type: "string" }, env: { type: "string" } } }));
  } catch {
    // Unexpected arguments may contain secrets. Print only the usage below.
  }
  const format = values?.format ?? "codex";
  const mode = values?.env ?? defaultEnv;
  if (!values || (format !== "json" && format !== "codex") || (mode !== "production" && mode !== "staging")) {
    console.error("Usage: ccc memtree-mcp --print-config [--format codex|json] [--env staging|production]");
    return 1;
  }

  const realNode = fs.realpathSync(process.execPath);
  const command = directMcpNodePath(realNode);
  const cli = fs.realpathSync(new URL("./cli.js", import.meta.url));
  if (command === realNode) {
    const note = "# Using the resolved Node binary. Rerun ccc memtree-mcp --print-config if an upgrade moves it.";
    (format === "json" ? process.stderr : process.stdout).write(note + "\n");
  }
  process.stdout.write(formatDirectMcpConfig(format, command, cli, mode) + "\n");
  return 0;
}

/** The `--mcp-config` JSON for this ccc's server, bound to its proxy. */
export function memtreeMcpConfig(proxyUrl: string, hostToken?: string): object {
  return {
    mcpServers: {
      [MEMTREE_MCP_SERVER_NAME]: {
        type: "stdio",
        command: process.execPath,
        args: [MEMTREE_MCP_SCRIPT],
        // The proxy's version, so a server started after an update can tell.
        // The host token lets this server ask which session its process is on.
        env: { CCC_MEMTREE_PROXY: proxyUrl, [PROXY_VERSION_ENV]: CLIENT_VERSION,
          ...(hostToken ? { [HOST_TOKEN_ENV]: hostToken } : {}) },
        alwaysLoad: true,
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
  tempRoot: string = os.tmpdir(),
  hostToken?: string
): MemtreeMcpConfigFile {
  const dir = fs.mkdtempSync(path.join(tempRoot, "ccc-memtree-mcp-"));
  const file = path.join(dir, "mcp.json");
  fs.writeFileSync(file, JSON.stringify(memtreeMcpConfig(proxyUrl, hostToken)), { mode: 0o600 });
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

export interface MemtreeMcpPlan {
  /** ccc registers its own server (`--mcp-config` + `--allowedTools`). */
  register: boolean;
  /** The tools the session will have (bare names): the `x-memtree-tools`
   * value, and what ccc pre-allows when it registers. Empty: no header. */
  tools: string[];
}

/**
 * Whether ccc adds its `memtree` server to this Claude argv, and which tools
 * the session then has. The same for interactive and print/non-TTY runs.
 */
export function planMemtreeMcp(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd()
): MemtreeMcpPlan {
  const disallowed = new Set(disallowedMemtreeTools(args));
  const tools = MEMTREE_TOOL_NAMES.filter((tool) => !disallowed.has(tool));
  const callerServer = memtreeServerInArgs(args, cwd);
  if (callerServer === "ccc") return { register: false, tools };
  if (callerServer !== "none" || !memtreeMcpEnabledByEnv(env) || tools.length === 0) {
    return { register: false, tools: [] };
  }
  return { register: true, tools };
}

/** Prepend the options; `=` forms so no variadic option swallows user argv. */
export function withMemtreeMcpArgs(
  args: readonly string[],
  configPath: string,
  tools: readonly string[] = MEMTREE_TOOL_NAMES
): string[] {
  return [
    `--mcp-config=${configPath}`,
    `--allowedTools=${tools.map(memtreeToolName).join(",")}`,
    ...args,
  ];
}

/**
 * The memtree tools (bare names) that `--disallowedTools` /
 * `--disallowed-tools` rules in Claude's argv name: the tool itself, the
 * whole server (`mcp__memtree`), or a `*` pattern such as `mcp__memtree__*`.
 */
export function disallowedMemtreeTools(args: readonly string[]): string[] {
  const rules = optionValues(args, ["--disallowedTools", "--disallowed-tools"])
    .flatMap((value) => value.split(/[\s,]+/))
    .filter(Boolean);
  return MEMTREE_TOOL_NAMES.filter((tool) =>
    rules.some((rule) => ruleMatchesMemtreeTool(rule, tool))
  );
}

/**
 * The `--mcp-config` values in Claude's argv (before `--`): each is a file
 * path or an inline JSON string. Handles `--mcp-config a b` (variadic, up to
 * the next option) and `--mcp-config=a`.
 */
export function mcpConfigArgs(args: readonly string[]): string[] {
  return optionValues(args, ["--mcp-config"]);
}

/**
 * The server named `memtree` in the argv's `--mcp-config` values, judged by
 * the last value that defines one (Claude Code keeps the last definition of
 * a name): "ccc" when it runs proxy-mode `memtree-mcp` (`ccc memtree-mcp`,
 * `ccc staging memtree-mcp`, or dist/memtree-mcp.js), "ccc-direct" when it
 * runs `memtree-mcp --direct` (which has no current tree, so compression must
 * not advertise current-tree reads), "other" for someone else's, "unknown"
 * when a value ccc cannot read or parse comes after it (it may define one),
 * and "none" otherwise. Only `--mcp-config` can override ccc's server: it
 * beats a project `.mcp.json` server of the same name (checked on Claude Code
 * 2.1.302), and plugin servers get `plugin_…` names.
 */
export function memtreeServerInArgs(
  args: readonly string[],
  cwd: string = process.cwd()
): "ccc" | "ccc-direct" | "other" | "unknown" | "none" {
  let found: "ccc" | "ccc-direct" | "other" | "unknown" | "none" = "none";
  for (const value of mcpConfigArgs(args)) {
    const server = memtreeServerIn(value, cwd);
    if (server === null) continue;
    found = server === undefined ? "unknown" : classifyMemtreeServer(server);
  }
  return found;
}

/** `--name value…` (variadic, up to the next option) and `--name=value`, before `--`. */
function optionValues(args: readonly string[], names: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    const inline = names.find((name) => arg.startsWith(`${name}=`));
    if (inline) {
      values.push(arg.slice(inline.length + 1));
      continue;
    }
    if (!names.includes(arg)) continue;
    while (i + 1 < args.length && !args[i + 1].startsWith("-")) values.push(args[++i]);
  }
  return values;
}

/**
 * The `memtree` entry of one `--mcp-config` value (file or inline JSON):
 * null when it defines none, undefined when it cannot be read or parsed.
 */
function memtreeServerIn(value: string, cwd: string): object | null | undefined {
  let parsed: unknown;
  try {
    const text = value.trim().startsWith("{")
      ? value
      : fs.readFileSync(path.resolve(cwd, value), "utf-8");
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const server = (parsed as { mcpServers?: Record<string, unknown> } | null)?.mcpServers?.[
    MEMTREE_MCP_SERVER_NAME
  ];
  if (server === undefined) return null;
  return server && typeof server === "object" ? server : undefined;
}

function basenameAny(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
}

/**
 * Classify a `memtree` server entry:
 * - "ccc": runs ccc's proxy-mode `memtree-mcp` (has this session's current tree).
 * - "ccc-direct": runs `memtree-mcp --direct` (no current tree; omit `x-memtree-tools`).
 * - "other": anything else (non-stdio, another server, or `--print-config`).
 */
function classifyMemtreeServer(
  server: { type?: unknown; command?: unknown; args?: unknown }
): "ccc" | "ccc-direct" | "other" {
  if (server.type !== undefined && server.type !== "stdio") return "other";
  const parts = [server.command, ...(Array.isArray(server.args) ? server.args : [])];
  const index = parts.findIndex(
    (part) => typeof part === "string" && /^memtree-mcp(\.js)?$/.test(basenameAny(part))
  );
  if (index < 0 || parts.slice(1, index).includes("--")) return "other";
  const tail = parts.slice(index + 1);
  if (tail[0] === "--print-config" && basenameAny(parts[index] as string) === "memtree-mcp") {
    return "other";
  }
  const endOptions = tail.indexOf("--");
  const optionArgs = endOptions < 0 ? tail : tail.slice(0, endOptions);
  return optionArgs.includes("--direct") ? "ccc-direct" : "ccc";
}

function memtreeToolName(tool: string): string {
  return `mcp__${MEMTREE_MCP_SERVER_NAME}__${tool}`;
}

/** A permission rule naming this tool, its whole server, or a `*` pattern over it. */
function ruleMatchesMemtreeTool(rule: string, tool: string): boolean {
  if (rule === `mcp__${MEMTREE_MCP_SERVER_NAME}`) return true;
  const pattern = rule.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${pattern}$`).test(memtreeToolName(tool));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
