import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
// One FIFO mailbox per launcher. Only the worker opens checkpoints or walks prompt
// bytes. Keep the process alive while a settled turn is on its way to the outbox.
let worker;
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
    constructor(sessionId, report, scope, cacheDirectory) {
        this.sessionId = sessionId;
        this.report = report;
        this.scope = scope;
        this.cacheDirectory = cacheDirectory;
    }
    dispatched(laneKey, at) {
        this.requestedAt = at;
        if (this.cacheDirectory) {
            try {
                accountingWorker().postMessage({ kind: 'dispatch', id: this.id, sessionId: this.sessionId,
                    cacheDirectory: this.cacheDirectory, laneKey, at, order: process.hrtime.bigint() });
            }
            catch { /* Forward even if the worker is unavailable. */ }
        }
    }
    async settle(input, status) {
        if (this.closed)
            return;
        this.closed = true;
        if (input.nowMs === undefined)
            return;
        try {
            if (this.requestedAt === undefined)
                this.dispatched(input.laneKey ?? 'main', input.nowMs);
            const current = accountingWorker();
            const result = await new Promise((resolve) => {
                current.postMessage({ kind: 'settle', id: this.id, sessionId: this.sessionId,
                    scope: this.scope, input, status });
                pending.set(this.id, resolve);
                current.ref();
            });
            if (result)
                this.report(result);
        }
        catch { /* Accounting never determines request delivery. */ }
    }
}
//# sourceMappingURL=savings-turn.js.map