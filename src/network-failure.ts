/**
 * Connection failures (no answer at all) to MemTree or Anthropic, and the refusal a turn
 * gets while one can't be reached. 2026-11-09: with the network down, compression failed
 * with getaddrinfo ENOTFOUND and over-budget turns were refused as "MemTree couldn't fit
 * this request ... run /ccc:memtree-compact or /clear", blaming the fit for the network.
 */

/** Error codes that mean the peer could not be reached: DNS, connect, or a dropped socket. */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ECONNREFUSED", "ECONNRESET", "ECONNABORTED",
  "ETIMEDOUT", "EHOSTUNREACH", "EHOSTDOWN", "ENETUNREACH", "ENETDOWN", "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);

/** A failure this recent still explains a refusal (outlasts the 60 s outage cooldown). */
export const NETWORK_FAILURE_FRESH_MS = 2 * 60_000;

/** A call that got no answer because its host could not be reached. */
export interface NetworkFailure {
  code: string;
  host: string;
  at: number;
}

/** The network failure `err` describes (its own code or its cause's), else undefined. */
export function networkFailureOf(
  err: unknown, host: string, now = Date.now()
): NetworkFailure | undefined {
  const code = errorCode(err) ?? errorCode((err as { cause?: unknown } | undefined)?.cause);
  return code !== undefined && UNREACHABLE_CODES.has(code) ? { code, host, at: now } : undefined;
}

/** `failure` when it is recent enough to explain what happens now. */
export function freshFailure(
  failure: NetworkFailure | undefined, now = Date.now()
): NetworkFailure | undefined {
  return failure && now - failure.at <= NETWORK_FAILURE_FRESH_MS ? failure : undefined;
}

/**
 * What a turn is told while MemTree (and maybe Anthropic too) can't be reached: the
 * internet when neither answers, else the one that doesn't. Never the fit, /compact or /clear.
 */
export function unreachableMessage(
  memtree: NetworkFailure | undefined, anthropic: NetworkFailure | undefined
): string {
  if (memtree && anthropic) {
    return "ccc can't reach the internet (MemTree at " + `${memtree.host}: ${memtree.code}; ` +
      `Anthropic at ${anthropic.host}: ${anthropic.code}). Check your connection and retry.`;
  }
  const [name, failure] = memtree ? ["MemTree", memtree] : ["Anthropic", anthropic!];
  return `ccc can't reach ${name} (${failure.host}: ${failure.code}). ` +
    "Check your internet connection and retry.";
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}
