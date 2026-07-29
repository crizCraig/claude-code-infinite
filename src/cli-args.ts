/** Wrapper-only command-line options consumed by `ccc` before Claude's `--`. */
export interface WrapperArgs {
  claudeArgs: string[];
  debug: boolean;
  /** Buffered A/B delivery is the default; `--ab-speculative` opts in. */
  speculativeAb: boolean;
  /**
   * True when either A/B delivery flag was passed before `--`. An explicit
   * flag is an unambiguous request for A/B routing, so cli.ts treats it as an
   * opt-in equivalent to `CCC_AB_ROUTING=1` (an explicit `CCC_AB_ROUTING=0`
   * still wins and the flag is warned about instead of silently ignored).
   */
  abDeliveryRequested: boolean;
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
 * flags. The last A/B delivery flag wins so scripts can override an earlier
 * default explicitly.
 */
export function parseWrapperArgs(args: string[]): WrapperArgs {
  const claudeArgs: string[] = [];
  let beforeSeparator = true;
  let debug = false;
  let speculativeAb = false;
  let abDeliveryRequested = false;

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
      abDeliveryRequested = true;
      continue;
    }
    if (beforeSeparator && arg === "--ab-buffered") {
      speculativeAb = false;
      abDeliveryRequested = true;
      continue;
    }
    claudeArgs.push(arg);
  }

  return { claudeArgs, debug, speculativeAb, abDeliveryRequested };
}

/** How A/B routing was resolved from the env switch and the delivery flags. */
export interface AbRoutingDecision {
  enabled: boolean;
  /**
   * True when a delivery flag lost to an explicit `CCC_AB_ROUTING=0` — the
   * caller should warn instead of letting the flag be a silent no-op.
   */
  warnFlagIgnored: boolean;
}

/**
 * A/B routing is opt-in: `CCC_AB_ROUTING=1` enables it, and so does an
 * explicit `--ab-speculative`/`--ab-buffered` flag (a user passing one
 * unambiguously wants A/B routing). `CCC_AB_ROUTING=0` is the explicit
 * disable and wins over the flags.
 */
export function resolveAbRouting(
  envValue: string | undefined,
  abDeliveryRequested: boolean
): AbRoutingDecision {
  const explicitlyDisabled = envValue === "0";
  return {
    enabled: envValue === "1" || (abDeliveryRequested && !explicitlyDisabled),
    warnFlagIgnored: abDeliveryRequested && explicitlyDisabled,
  };
}
