/**
 * What a session's lanes have been sending, for two one-line notices (2026-11-12,
 * ai-safety-sim session cf649598: a video agent sent 375 requests of 15-27 MB, almost
 * all base64 contact sheets, 97-217 s to first byte on home wifi; when the main lane
 * was then refused, the agent's finished result could not reach the main session):
 *
 * - heavy requests: once per session, when a body sent to Anthropic passes
 *   HEAVY_REQUEST_BYTES, say images (or the session's history) make each turn that many MB
 *   to upload;
 * - agent activity: whether an agent lane of the session sent a request recently, so a
 *   main-lane refusal can say a background agent's result may be waiting.
 */

/** A request this large is slow to upload on a weak connection (~20 s at 8 Mbit/s). */
export const HEAVY_REQUEST_BYTES = 20_000_000;
/** How long after its last request an agent lane still counts as recently active. */
export const RECENT_AGENT_MS = 30 * 60_000;
const MAX_SESSIONS = 256;

export interface HeavyRequest { bytes: number; imageBytes: number }

export class LaneActivity {
  private readonly heavy = new Map<string, HeavyRequest>();
  private readonly warned = new Set<string>();
  private readonly agentSeen = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Note a request of the session on `lane` (an agent lane counts as recent activity). */
  seen(sessionId: string | undefined, lane: string | undefined): void {
    if (sessionId !== undefined && lane === "agent") bounded(this.agentSeen, sessionId, this.now());
  }

  /** Note what a request of the session uploaded: its body size and image bytes. */
  sent(sessionId: string | undefined, request: HeavyRequest): void {
    if (sessionId === undefined) return;
    if (request.bytes < HEAVY_REQUEST_BYTES || this.warned.has(sessionId)) return;
    const known = this.heavy.get(sessionId);
    if (!known || request.bytes > known.bytes) bounded(this.heavy, sessionId, request);
  }

  /** The session's largest heavy request when it has not been warned about yet. */
  heavyDue(sessionId: string | undefined): HeavyRequest | undefined {
    return sessionId === undefined || this.warned.has(sessionId)
      ? undefined : this.heavy.get(sessionId);
  }

  /** The warning was shown: never again for this session. */
  markWarned(sessionId: string): void {
    this.heavy.delete(sessionId);
    this.warned.add(sessionId);
    if (this.warned.size > MAX_SESSIONS) this.warned.delete(this.warned.values().next().value!);
  }

  /** Whether an agent lane of the session sent a request within RECENT_AGENT_MS. */
  agentRecent(sessionId: string | undefined): boolean {
    const seen = sessionId === undefined ? undefined : this.agentSeen.get(sessionId);
    return seen !== undefined && this.now() - seen <= RECENT_AGENT_MS;
  }
}

/** "⚠ Images are making each turn ~22 MB to upload: slow on weak connections. ..." */
export function heavyRequestNoticeText(request: HeavyRequest): string {
  const size = `~${Math.round(request.bytes / 1_000_000)} MB`;
  const what = request.imageBytes * 2 >= request.bytes
    ? `Images are making each turn ${size} to upload`
    : `Each turn of this session uploads ${size}`;
  const advice = request.imageBytes * 2 >= request.bytes
    ? " Fewer or smaller images (lower-resolution screenshots or contact sheets) keep turns fast."
    : "";
  return `⚠ ${what}: slow on weak connections.${advice}`;
}

/** The line a main-lane refusal adds while an agent lane was recently active. */
export const AGENT_RESULT_WAITING_LINE =
  "A background agent's result may be waiting: it arrives once this session's turns go " +
  "through again.";

function bounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_SESSIONS) map.delete(map.keys().next().value!);
}
