import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { readPrivateFile, writeAtomically } from './prefix-store.js';
import { acquireUpdateLock, releaseUpdateLock } from './update-lock.js';
import { SavingsHistory } from './savings-history.js';
import { accountSavingsTurn, createSavingsState, isSavingsState, normalizeSavingsUsage, refineSavingsState, savingsLaneKey } from './savings.js';
const sends = new Map();
const memory = new Map();
let evicted = false;
const history = new SavingsHistory();
const waitWord = new Int32Array(new SharedArrayBuffer(4));
function empty(unknownHistory) {
    return { ...createSavingsState(), unknownHistory };
}
function readState(dir, possiblyResumed) {
    const file = join(dir, 'floor-v1.json');
    const body = readPrivateFile(file, 32 * 1024 * 1024);
    if (body) {
        try {
            const state = JSON.parse(body);
            if (isSavingsState(state))
                return state;
        }
        catch { /* A partial or legacy history cannot establish a first send. */ }
        return empty(true);
    }
    const hasOldHistory = readdirSync(dir).some(name => name !== 'lock' && !name.startsWith('pending.'));
    return empty(possiblyResumed || hasOldHistory);
}
/** Only the accounting worker waits on this lock. Readers never lose another
 * launcher's additions to the union of all previously sent plain prefixes. */
function updateLane(lane, update) {
    const dir = lane.directory;
    if (dir) {
        let token = null;
        const lock = join(dir, 'lock');
        try {
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            const deadline = Date.now() + 2000;
            while (!(token = acquireUpdateLock(lock, Date.now())) && Date.now() < deadline) {
                Atomics.wait(waitWord, 0, 0, 10);
            }
            if (!token)
                throw Error('history busy');
            const state = readState(dir, lane.possiblyResumed);
            if (existsSync(join(dir, 'incomplete')))
                state.unknownHistory = true;
            const next = update(state);
            if (writeAtomically(dir, join(dir, 'floor-v1.json'), JSON.stringify(next)))
                return true;
        }
        catch { /* Storage failure must favor the cheaper plain price. */ }
        finally {
            if (token)
                releaseUpdateLock(lock, token);
        }
        try {
            writeFileSync(join(dir, 'incomplete'), '', { mode: 0o600 });
        }
        catch { /* No writable store. */ }
    }
    const previous = memory.get(lane.key) ?? empty(!!dir || lane.possiblyResumed || evicted);
    memory.delete(lane.key);
    memory.set(lane.key, update(previous));
    if (memory.size > 200) {
        memory.delete(memory.keys().next().value);
        evicted = true;
    }
    return !dir;
}
function dispatch(job) {
    const raw = job.input.request;
    const bytes = raw instanceof Uint8Array ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) : undefined;
    const request = bytes ? JSON.parse(bytes.toString('utf8')) : raw;
    const key = savingsLaneKey(job.input.laneKey ?? 'main');
    const session = join(job.cacheDirectory ?? job.scope ?? '', job.sessionId, key);
    const lane = { key: session, directory: job.cacheDirectory ? session : undefined,
        possiblyResumed: job.input.possiblyResumed === true || Array.isArray(request?.messages) && request.messages.some((m) => m?.role === 'assistant') };
    const replay = bytes ? history.request(session, bytes) : undefined;
    const input = { ...job.input, request, replay, usage: undefined };
    const recorded = updateLane(lane, previous => {
        let uncertain = job.announcementFailed;
        if (lane.directory) {
            try {
                uncertain ||= readdirSync(lane.directory).some(name => name.startsWith('pending.') && !name.startsWith('pending.' + job.writer + '.'));
            }
            catch {
                uncertain = true;
            }
        }
        // Only this turn needs to assume a possible hit while a sibling worker
        // has an announced but unregistered send. Keep the union of known sends.
        const before = uncertain ? { ...previous, unknownHistory: true } : previous;
        const { state } = accountSavingsTurn(previous, input);
        sends.set(job.id, { sessionId: job.sessionId, lane, input, before, dispatched: state });
        return state;
    });
    if (recorded && job.reservation) {
        try {
            unlinkSync(job.reservation);
        }
        catch { /* An extra reservation only lowers future baselines. */ }
    }
}
function settle({ id, usage, status }) {
    const send = sends.get(id);
    sends.delete(id);
    if (!send)
        return;
    const { input, before, sessionId } = send;
    const success = status >= 200 && status < 300;
    const refused = [400, 401, 403, 404, 413, 422, 429].includes(status);
    const { turn, state } = accountSavingsTurn(before, { ...input, usage: success ? usage : undefined });
    // The send already happened, including on a 429. Only an unmodified,
    // measured response can improve what we knew about plain's token boundary.
    if (success && turn.actual_tokens && !input.requestModified) {
        updateLane(send.lane, current => refineSavingsState(current, state, send.dispatched));
    }
    const zero = refused ? normalizeSavingsUsage({ input_tokens: 0, output_tokens: 0 }) : null;
    return {
        turn_id: id, session_id: sessionId, requested_at: new Date(input.nowMs).toISOString(),
        model: input.model ?? input.request?.model, fast_mode: turn.fast_mode,
        actual: turn.actual_tokens ?? zero, plain: turn.actual_tokens ? turn.plain_tokens : zero,
        window_crossing: success && turn.window_crossing,
        floor_read_possibly_uncached_tokens: turn.actual_tokens ? turn.floor_read_possibly_uncached_tokens : refused ? 0 : null,
        floor_read_max_gap_seconds: turn.actual_tokens ? turn.floor_read_max_gap_seconds : refused ? 0 : null,
    };
}
parentPort.on('message', (job) => {
    if (job.kind === 'dispatch') {
        try {
            dispatch(job);
        }
        catch { /* Savings cannot interrupt upstream delivery. */ }
        return;
    }
    let report;
    try {
        report = settle(job);
    }
    catch { /* Unusable observation. */ }
    parentPort.postMessage({ id: job.id, report });
});
//# sourceMappingURL=savings-worker.js.map