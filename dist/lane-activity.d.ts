/**
 * What a session's lanes have been sending, for two one-line notices (2026-11-12,
 * ai-safety-sim session cf649598: a video agent sent 375 requests of 15-27 MB, almost
 * all base64 contact sheets, 97-217 s to first byte on home wifi; when the main lane
 * was then refused, the agent's finished result could not reach the main session):
 *
 * - heavy requests: once per session, when a request body passes HEAVY_REQUEST_BYTES,
 *   say images (or the session's history) make each turn that many MB to upload;
 * - agent activity: whether an agent lane of the session sent a request recently, so a
 *   main-lane refusal can say a background agent's result may be waiting.
 */
/** A request this large is slow to upload on a weak connection (~20 s at 8 Mbit/s). */
export declare const HEAVY_REQUEST_BYTES = 20000000;
/** How long after its last request an agent lane still counts as recently active. */
export declare const RECENT_AGENT_MS: number;
export interface HeavyRequest {
    bytes: number;
    imageBytes: number;
}
export declare class LaneActivity {
    private readonly now;
    private readonly heavy;
    private readonly warned;
    private readonly agentSeen;
    constructor(now?: () => number);
    /** Note a request of the session: its body size and image bytes, and its lane. */
    note(sessionId: string | undefined, lane: string | undefined, request: HeavyRequest): void;
    /** The session's largest heavy request when it has not been warned about yet. */
    heavyDue(sessionId: string | undefined): HeavyRequest | undefined;
    /** The warning was shown: never again for this session. */
    markWarned(sessionId: string): void;
    /** Whether an agent lane of the session sent a request within RECENT_AGENT_MS. */
    agentRecent(sessionId: string | undefined): boolean;
}
/** "⚠ Images are making each turn ~22 MB to upload: slow on weak connections. ..." */
export declare function heavyRequestNoticeText(request: HeavyRequest): string;
/** The line a main-lane refusal adds while an agent lane was recently active. */
export declare const AGENT_RESULT_WAITING_LINE: string;
//# sourceMappingURL=lane-activity.d.ts.map