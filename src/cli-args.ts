/** Wrapper-only command-line options consumed by `ccc` before Claude's `--`. */
export interface WrapperArgs {
  claudeArgs: string[];
  debug: boolean;
  /** Unsafe research mode; buffered A/B delivery remains the default. */
  speculativeAb: boolean;
}

/**
 * Consume ccc's own flags only before the conventional `--` separator. Values
 * after it are literal Claude arguments/prompts, even when they look like ccc
 * flags. The last A/B delivery flag wins so scripts can override an earlier
 * default explicitly.
 */
export function parseWrapperArgs(args: string[]): WrapperArgs {
  const claudeArgs: string[] = [];
  let beforeSeparator = true;
  let debug = false;
  let speculativeAb = false;

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
    if (beforeSeparator && arg === "--ab-speculative") {
      speculativeAb = true;
      continue;
    }
    if (beforeSeparator && arg === "--ab-buffered") {
      speculativeAb = false;
      continue;
    }
    claudeArgs.push(arg);
  }

  return { claudeArgs, debug, speculativeAb };
}
