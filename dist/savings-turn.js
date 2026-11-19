import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LAUNCH_TIME, retireReservation } from './savings-owner.js';
import { Worker } from 'node:worker_threads';
import { savingsLaneKey } from './savings.js';
// The launcher queues sends before the response can settle. The worker owns
// history updates and the snapshot used to price each response.
let worker;
let writer = randomUUID();
const submittedReservations = new Set();
const pending = new Map();
function accountingWorker() {
    if (worker)
        return worker;
    const current = new Worker(new URL('./savings-worker.js', import.meta.url), { execArgv: [] });
    worker = current;
    current.on('message', ({ id, ...reply }) => {
        pending.get(id)?.(reply);
        pending.delete(id);
        if (!pending.size)
            current.unref();
    });
    current.on('error', () => { });
    current.on('exit', () => {
        // Only submissions handed to the exited worker can be retired. A live
        // announcement may still send through the replacement worker.
        for (const path of submittedReservations)
            retireReservation(path);
        submittedReservations.clear();
        worker = undefined;
        writer = randomUUID();
        for (const finish of pending.values())
            finish({});
        pending.clear();
    });
    current.unref();
    return current;
}
function settleOnWorker(job) {
    const current = accountingWorker();
    return new Promise(resolve => {
        current.postMessage(job);
        pending.set(job.id, resolve);
        current.ref();
    });
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
        const file = join(dir, `pending.${writer}.${this.id}.${process.pid}.${LAUNCH_TIME}`);
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
            this.report.dispatched?.(this.incomplete(input));
            if (this.reservation)
                submittedReservations.add(this.reservation);
            accountingWorker().postMessage({ kind: 'dispatch', id: this.id, sessionId: this.sessionId,
                scope: this.scope, cacheDirectory: this.cacheDirectory, writer, reservation: this.reservation,
                announcementFailed: this.announcementFailed, input });
        }
        catch { /* Forward even if the worker is unavailable. */ }
    }
    async settle(input, status, countPrefix) {
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
            const job = { kind: 'settle', id: this.id, usage: input.usage, status,
                prefixCount: input.prefixCount, interruptedStream: input.interruptedStream };
            let reply = await settleOnWorker({ ...job, canCount: !!countPrefix });
            if (reply.countMessages !== undefined && countPrefix) {
                const messages = reply.countMessages;
                let tokens;
                try {
                    tokens = await countPrefix(messages);
                }
                catch { /* Settle as unmeasured. */ }
                const prefixCount = tokens === undefined ? undefined : { messages, tokens };
                reply = await settleOnWorker({ ...job, prefixCount });
            }
            result = reply.report;
        }
        catch { /* Preserve the dispatch as incomplete if accounting failed. */ }
        if (this.reservation && submittedReservations.delete(this.reservation) && !result) {
            retireReservation(this.reservation);
        }
        this.report(result ?? this.incomplete(input));
    }
    incomplete(input) {
        return {
            turn_id: this.id, session_id: this.sessionId, requested_at: new Date(input.nowMs).toISOString(),
            model: input.model ?? input.request?.model ?? 'unknown',
            incomplete_reason: 'interrupted_dispatch', fast_mode: false, window_crossing: false, actual: null, plain: null,
            floor_read_possibly_uncached_tokens: null, floor_read_max_gap_seconds: null,
        };
    }
}
//# sourceMappingURL=savings-turn.js.map