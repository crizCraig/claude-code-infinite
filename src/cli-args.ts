import type { BoardRequest } from "./board-channel.js";

/** Wrapper-only command-line options consumed by `ccc` before Claude's `--`. */
export interface WrapperArgs {
  claudeArgs: string[];
  debug: boolean;
  /** `--board` / `--board=PATH`: the board's channel server (board-channel.ts). */
  board: BoardRequest;
}

/** Whether Claude's own print mode was requested before its `--` separator. */
export function isPrintInvocation(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "-p" || arg === "--print") return true;
  }
  return false;
}

/**
 * `ccc --version` / `ccc -v` (alone, or after `local`/`staging`): answered by ccc itself,
 * with no MemTree key, proxy or session, so it works right after installing.
 */
export function isVersionRequest(args: readonly string[]): boolean {
  const start = ENVIRONMENT_WORDS.includes(args[0] ?? "") ? 1 : 0;
  const rest = args.slice(start);
  return rest.length === 1 && (rest[0] === "--version" || rest[0] === "-v");
}

/** ccc's own subcommands, which start no Claude session. */
const SUBCOMMANDS = ["fetch", "memtree-mcp", "link"] as const;
const ENVIRONMENT_WORDS = ["local", "staging"];

export type CccEnvironment = "production" | "staging" | "local";

/** The environment a leading `local`/`staging` word selects (else production). */
export function environmentOf(args: readonly string[]): CccEnvironment {
  return args[0] === "local" ? "local" : args[0] === "staging" ? "staging" : "production";
}

/**
 * A ccc subcommand and its arguments: the first word, or the word after
 * `local`/`staging` (`ccc staging memtree-mcp` is the same server as
 * `ccc memtree-mcp`; the environment is the proxy's, from its base URL).
 */
export function subcommandArgs(
  args: readonly string[]
): { name: (typeof SUBCOMMANDS)[number]; args: string[] } | undefined {
  const start = ENVIRONMENT_WORDS.includes(args[0] ?? "") ? 1 : 0;
  const name = SUBCOMMANDS.find((command) => command === args[start]);
  return name ? { name, args: args.slice(start + 1) } : undefined;
}

/**
 * Consume ccc's own flags only before the conventional `--` separator. Values
 * after it are literal Claude arguments/prompts, even when they look like ccc
 * flags.
 */
export function parseWrapperArgs(args: string[]): WrapperArgs {
  const claudeArgs: string[] = [];
  let beforeSeparator = true;
  let debug = false;
  let board: BoardRequest = { on: false };

  for (const arg of args) {
    if (beforeSeparator && arg === "--") {
      beforeSeparator = false;
      claudeArgs.push(arg);
      continue;
    }
    if (beforeSeparator && arg === "--debug") {
      debug = true;
      continue;
    }
    if (beforeSeparator && (arg === "--board" || arg.startsWith("--board="))) {
      const value = arg.slice("--board=".length);
      board = value ? { on: true, path: value } : { on: true };
      continue;
    }
    claudeArgs.push(arg);
  }

  return { claudeArgs, debug, board };
}

export type MemtreeLinkPlacement = "turn" | "message" | "stop" | "success" | "off";
export const MEMTREE_LINK_PLACEMENTS: readonly MemtreeLinkPlacement[] = [
  "turn",
  "message",
  "stop",
  "success",
  "off",
];

/**
 * `CCC_MEMTREE_LINK`: where the MemTree page link is shown (see
 * ProxyOptions.memtreeLinkPlacement). Unset or unknown values fall back to
 * the proxy's default placement.
 */
export function memtreeLinkPlacementFromEnv(
  value: string | undefined
): MemtreeLinkPlacement | undefined {
  const normalized = value?.trim().toLowerCase();
  return (MEMTREE_LINK_PLACEMENTS as readonly string[]).includes(normalized ?? "")
    ? (normalized as MemtreeLinkPlacement)
    : undefined;
}

/**
 * `CCC_COMPACT_TARGET`: "500k" / "20000" sets every session's compaction
 * target; "off" starts every session with compaction off (the state
 * `/memtree-compact off` sets, for headless runs that cannot type it).
 * `value` is undefined when unset or invalid; `warning` explains an invalid one.
 */
export function compactTargetFromEnv(
  raw: string | undefined,
  parseTokens: (text: string) => number | undefined,
  minTokens: number
): { value: number | null | undefined; warning?: string } {
  if (!raw || !raw.trim()) return { value: undefined };
  if (/^off$/i.test(raw.trim())) return { value: null };
  const target = parseTokens(raw);
  if (target === undefined || target < minTokens) {
    return {
      value: undefined,
      warning: `ccc: ignoring CCC_COMPACT_TARGET=${raw} (use off, or a token count of at least ${minTokens / 1000}k)`,
    };
  }
  return { value: target };
}
