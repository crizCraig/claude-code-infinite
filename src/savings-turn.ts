import {randomUUID} from 'node:crypto';
import {mkdirSync, readdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {readPrivateFile, writeAtomically} from './prefix-store.js';
import {isSavingsLane, savingsLaneKey, type SavingsLane} from './savings.js';

interface Dispatch {
  dir: string;
  file: string;
  previousAt?: number;
  previous?: SavingsLane;
}

/** Each writer owns its dispatch file, so a slower response cannot overwrite a newer turn.
 * Only timestamps, token counts and hashed prompt prefixes are shared across launchers. */
export class SavingsObservation {
  readonly id = randomUUID();
  closed = false;
  requestedAt?: number;
  dispatch?: Dispatch;

  constructor(readonly sessionId: string, readonly report: (value: unknown) => void,
              private readonly cacheDirectory?: string) {}

  dispatched(laneKey: string, at: number): void {
    this.requestedAt = at;
    if (!this.cacheDirectory) return;
    try {
      const dir = join(this.cacheDirectory, this.sessionId, savingsLaneKey(laneKey));
      mkdirSync(dir, {recursive:true, mode:0o700});
      const file = join(dir, at + '.' + this.id);
      writeFileSync(file, '', {mode:0o600, flag:'wx'});
      const older = readdirSync(dir)
        .filter(name => /^\d+\.[0-9a-f-]{36}$/.test(name) && parseInt(name, 10) < at)
        .sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
      this.dispatch = {dir, file};
      if (!older.length) return;
      this.dispatch.previousAt = parseInt(older[0], 10);
      const body = readPrivateFile(join(dir, older[0]), 64 * 1024);
      if (body) {
        const lane: unknown = JSON.parse(body);
        if (isSavingsLane(lane, this.dispatch.previousAt)) {
          this.dispatch.previous = lane;
        }
      }
      for (const name of older.slice(1)) {
        try { unlinkSync(join(dir, name)); } catch { /* A sibling pruned it. */ }
      }
    } catch { /* Missing cache evidence falls back to the observed median. */ }
  }

  remember(lane: SavingsLane): void {
    if (this.dispatch && isSavingsLane(lane, lane.at)) {
      writeAtomically(this.dispatch.dir, this.dispatch.file, JSON.stringify(lane));
    }
  }
}
