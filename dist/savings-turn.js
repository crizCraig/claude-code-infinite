import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPrivateFile, writeAtomically } from './prefix-store.js';
import { isSavingsLane, savingsLaneKey } from './savings.js';
/** Each writer owns its dispatch file, so a slower response cannot overwrite a newer turn.
 * Only timestamps, token counts and hashed prompt prefixes are shared across launchers. */
export class SavingsObservation {
    sessionId;
    report;
    cacheDirectory;
    id = randomUUID();
    closed = false;
    requestedAt;
    dispatch;
    constructor(sessionId, report, cacheDirectory) {
        this.sessionId = sessionId;
        this.report = report;
        this.cacheDirectory = cacheDirectory;
    }
    dispatched(laneKey, at) {
        this.requestedAt = at;
        if (!this.cacheDirectory)
            return;
        try {
            const dir = join(this.cacheDirectory, this.sessionId, savingsLaneKey(laneKey));
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            const file = join(dir, at + '.' + this.id);
            writeFileSync(file, '', { mode: 0o600, flag: 'wx' });
            const older = readdirSync(dir)
                .filter(name => /^\d+\.[0-9a-f-]{36}$/.test(name) && parseInt(name, 10) < at)
                .sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
            this.dispatch = { dir, file };
            if (!older.length)
                return;
            this.dispatch.previousAt = parseInt(older[0], 10);
            const body = readPrivateFile(join(dir, older[0]), 64 * 1024);
            if (body) {
                const lane = JSON.parse(body);
                if (isSavingsLane(lane, this.dispatch.previousAt)) {
                    this.dispatch.previous = lane;
                }
            }
            for (const name of older.slice(1)) {
                try {
                    unlinkSync(join(dir, name));
                }
                catch { /* A sibling pruned it. */ }
            }
        }
        catch { /* Missing cache evidence falls back to the observed median. */ }
    }
    remember(lane) {
        if (this.dispatch && isSavingsLane(lane, lane.at)) {
            writeAtomically(this.dispatch.dir, this.dispatch.file, JSON.stringify(lane));
        }
    }
}
//# sourceMappingURL=savings-turn.js.map