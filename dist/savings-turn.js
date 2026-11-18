import { randomUUID } from 'node:crypto';
const work = new WeakMap();
/** A context_memory POST can start before, during or after its source turn. */
export class SavingsObservation {
    sessionId;
    enabled;
    report;
    id = randomUUID();
    calls = 0;
    closed = false;
    constructor(sessionId, enabled, report) {
        this.sessionId = sessionId;
        this.enabled = enabled;
        this.report = report;
    }
    work(metadata) {
        const attributable = { ...metadata };
        work.set(attributable, this);
        return attributable;
    }
}
/** Count submitted calls until the server definitively refuses them before billable work.
 * A lost response after upload is ambiguous, so its charge remains expected. */
export function beginSavingsSubmission(metadata) {
    const turn = metadata && work.get(metadata);
    if (!turn || turn.closed || !turn.enabled())
        return;
    turn.calls++;
    return {
        metadata: { ...metadata, savings_turn_id: turn.id },
        unbilled() { turn.calls--; },
    };
}
//# sourceMappingURL=savings-turn.js.map