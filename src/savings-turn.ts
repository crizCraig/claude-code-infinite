import { randomUUID } from 'node:crypto';

const work = new WeakMap<Record<string, string>, SavingsObservation>();

/** A context_memory POST can start before, during or after its source turn. */
export class SavingsObservation {
  readonly id = randomUUID();
  calls = 0;
  closed = false;

  constructor(readonly sessionId: string, readonly enabled: () => boolean,
              readonly report: (value: unknown) => void) {}

  work(metadata: Record<string, string>): Record<string, string> {
    const attributable = {...metadata};
    work.set(attributable, this);
    return attributable;
  }
}

/** Count submitted calls until the server definitively refuses them before billable work.
 * A lost response after upload is ambiguous, so its charge remains expected. */
export function beginSavingsSubmission(metadata?: Record<string, string>) {
  const turn = metadata && work.get(metadata);
  if (!turn || turn.closed || !turn.enabled()) return;
  turn.calls++;
  return {
    metadata: {...metadata, savings_turn_id:turn.id},
    unbilled() { turn.calls--; },
  };
}
