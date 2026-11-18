import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { savingsLaneKey } from './savings.js';
// The launcher queues sends before the response can settle. The worker owns
// prompt hashing, persistence and the snapshot used to price each response.
let worker;
let writer = randomUUID();
const pending = new Map();
function accountingWorker() {
    if (worker)
        return worker;
    const current = new Worker(new URL('./savings-worker.js', import.meta.url), { execArgv: [] });
    worker = current;
    current.on('message', ({ id, report }) => {
        pending.get(id)?.(report);
        pending.delete(id);
        if (!pending.size)
            current.unref();
    });
    current.on('error', () => { });
    current.on('exit', () => {
        worker = undefined;
        writer = randomUUID();
        for (const finish of pending.values())
            finish(undefined);
        pending.clear();
    });
    current.unref();
    return current;
}
export class SavingsObservation {
    sessionId;
    report;
    scope;
    cacheDirectory;
    id = randomUUID();
    requestedAt;
    closed = false;
    reservation;
    announcementFailed = false;
    constructor(sessionId, report, scope, cacheDirectory) {
        this.sessionId = sessionId;
        this.report = report;
        this.scope = scope;
        this.cacheDirectory = cacheDirectory;
    }
    /** Publish an empty, private reservation before sending. Another launcher's
     * worker can now see this dispatch even if our own worker is backlogged. */
    async announce(laneKey) {
        if (!this.cacheDirectory)
            return;
        const dir = join(this.cacheDirectory, this.sessionId, savingsLaneKey(laneKey));
        const file = join(dir, `pending.${writer}.${this.id}`);
        try {
            await mkdir(dir, { recursive: true, mode: 0o700 });
            await writeFile(file, '', { flag: 'wx', mode: 0o600 });
            this.reservation = file;
        }
        catch {
            this.announcementFailed = true;
        }
    }
    dispatched(input) {
        if (input.nowMs === undefined || this.requestedAt !== undefined)
            return;
        this.requestedAt = input.nowMs;
        try {
            accountingWorker().postMessage({ kind: 'dispatch', id: this.id, sessionId: this.sessionId,
                scope: this.scope, cacheDirectory: this.cacheDirectory, writer, reservation: this.reservation,
                announcementFailed: this.announcementFailed, input });
        }
        catch { /* Forward even if the worker is unavailable. */ }
    }
    async settle(input, status) {
        if (this.closed)
            return;
        this.closed = true;
        if (input.nowMs === undefined) {
            if (this.reservation)
                await unlink(this.reservation).catch(() => { });
            return;
        }
        let result;
        try {
            if (this.requestedAt === undefined) {
                if (!this.reservation)
                    await this.announce(input.laneKey ?? 'main');
                this.dispatched(input);
            }
            const current = accountingWorker();
            result = await new Promise((resolve) => {
                current.postMessage({ kind: 'settle', id: this.id, usage: input.usage, status });
                pending.set(this.id, resolve);
                current.ref();
            });
        }
        catch { /* Preserve the dispatch as incomplete if accounting failed. */ }
        this.report(result ?? {
            turn_id: this.id, session_id: this.sessionId, requested_at: new Date(input.nowMs).toISOString(),
            model: input.model ?? input.request?.model ?? 'unknown',
            fast_mode: false, window_crossing: false, actual: null, plain: null,
            floor_read_possibly_uncached_tokens: null, floor_read_max_gap_seconds: null,
        });
    }
}
//# sourceMappingURL=savings-turn.js.map