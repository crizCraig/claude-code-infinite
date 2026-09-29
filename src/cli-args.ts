/** Wrapper-only command-line options consumed by `ccc` before Claude's `--`. */
export interface WrapperArgs {
  claudeArgs: string[];
  debug: boolean;
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
 * Consume ccc's own flags only before the conventional `--` separator. Values
 * after it are literal Claude arguments/prompts, even when they look like ccc
 * flags.
 */
export function parseWrapperArgs(args: string[]): WrapperArgs {
  const claudeArgs: string[] = [];
  let beforeSeparator = true;
  let debug = false;

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
    claudeArgs.push(arg);
  }

  return { claudeArgs, debug };
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
