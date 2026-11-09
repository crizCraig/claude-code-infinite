/**
 * Connection failures (no answer at all) to MemTree or Anthropic, and the refusal a turn
 * gets while one can't be reached. 2026-11-09: with the network down, compression failed
 * with getaddrinfo ENOTFOUND and over-budget turns were refused as "MemTree couldn't fit
 * this request ... run /ccc:memtree-compact or /clear", blaming the fit for the network.
 *
 * Limit: a call aborted by its own deadline before the connect error arrives (undici gives
 * up connecting after 10 s; a caller's budget can be shorter) carries no code, so it is not
 * counted here and its refusal runs the usual strikes. Neither is a captive portal's TLS error.
 */

/**
 * Error codes that mean no connection could be made: DNS, or the connect itself. A reset or
 * a broken pipe on a connection that was up (a server restart, a proxy cutting a long call,
 * a stale keep-alive socket) is not one: the server may have taken the call, so those keep
 * the bounded strike episode (review r1).
 */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ECONNREFUSED", "EHOSTUNREACH", "EHOSTDOWN",
  "ENETUNREACH", "ENETDOWN", "UND_ERR_CONNECT_TIMEOUT",
]);
/** Codes that mean "unreachable" only when the connect itself failed (syscall "connect"). */
const CONNECT_ONLY_CODES: ReadonlySet<string> = new Set(["ETIMEDOUT", "ECONNRESET"]);

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
  const source = errorCode(err) !== undefined ? err : (err as { cause?: unknown } | undefined)?.cause;
  const code = errorCode(source);
  if (code === undefined) return undefined;
  const connecting = connectFailed(source);
  return UNREACHABLE_CODES.has(code) || (connecting && CONNECT_ONLY_CODES.has(code))
    ? { code, host, at: now } : undefined;
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

/**
 * Whether the connect itself failed: its syscall, or every attempt's (Node's happy-eyeballs
 * AggregateError carries the syscall only on its `errors`: review r2).
 */
function connectFailed(err: unknown): boolean {
  const { syscall, errors } = err as { syscall?: unknown; errors?: unknown };
  if (syscall === "connect") return true;
  return Array.isArray(errors) && errors.length > 0 &&
    errors.every((each) => (each as { syscall?: unknown } | null)?.syscall === "connect");
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}
