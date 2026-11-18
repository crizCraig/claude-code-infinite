import { lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPrivateFile, writeAtomically } from './prefix-store.js';
import { parentPort } from 'node:worker_threads';
import { SavingsHistory } from './savings-history.js';
import { accountSavingsTurn, createSavingsState, isSavingsLane, savingsLaneKey } from './savings.js';
// This worker consumes dispatch and settlement messages in forwarding order.
const dispatches = new Map();
const baselines = new Map();
const history = new SavingsHistory();
function readLane(file, at) {
    const body = readPrivateFile(file, 8 * 1024 * 1024);
    if (!body)
        return;
    try {
        const lane = JSON.parse(body);
        if (isSavingsLane(lane, at))
            return lane;
    }
    catch { /* No usable measurement. */ }
}
// Older launchers used <millis>.<uuid>. For equal wall-clock timestamps, new
// dispatches carry the monotonic clock sampled on the forwarding thread.
const checkpointName = /^(\d+)\.(?:(\d{20})\.)?[0-9a-f-]{36}$/;
function checkpoint({ cacheDirectory, sessionId, laneKey, at, order, id }) {
    try {
        const dir = join(cacheDirectory, sessionId, savingsLaneKey(laneKey));
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const sequence = order.toString().padStart(20, '0');
        const file = join(dir, [at, sequence, id].join('.'));
        writeFileSync(file, '', { mode: 0o600, flag: 'wx' });
        const dispatch = { dir, file, at, sequence };
        // Keep the predecessor of every still-open turn. A refused dispatch disappears
        // on settlement, so the last measured write may be several files behind it.
        let keepPrevious = true;
        for (const older of preceding(dispatch)) {
            try {
                const pending = lstatSync(older.file).size === 0;
                if (!keepPrevious && (!pending || at - older.at > 86_400_000))
                    unlinkSync(older.file);
                keepPrevious = pending;
            }
            catch { /* A sibling settled or pruned it. */ }
        }
        return dispatch;
    }
    catch { /* A missing checkpoint supplies no cache evidence. */ }
}
function preceding({ dir, at, sequence }) {
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return [];
    }
    return names.flatMap(name => {
        const match = checkpointName.exec(name);
        if (!match)
            return [];
        const time = Number(match[1]), tie = match[2] ?? '';
        return time < at || (time === at && tie < sequence) ? [{ file: join(dir, name), at: time, tie }] : [];
    }).sort((a, b) => b.at - a.at || b.tie.localeCompare(a.tie));
}
function settle(job) {
    const dispatch = dispatches.get(job.id);
    dispatches.delete(job.id);
    const { input, status } = job;
    const session = job.scope + '/' + job.sessionId;
    const lane = input.laneKey ?? 'main';
    const key = savingsLaneKey(lane);
    const success = status >= 200 && status < 300;
    const refused = [400, 401, 403, 404, 413, 422, 429].includes(status);
    const usage = success ? input.usage : refused
        ? { input_tokens: 0, output_tokens: 0 } : undefined;
    const bytes = input.request instanceof Uint8Array
        ? Buffer.from(input.request.buffer, input.request.byteOffset, input.request.byteLength) : undefined;
    const request = bytes ? JSON.parse(bytes.toString('utf8')) : input.request;
    const forwarded = success ? input.forwardedRequest : undefined;
    const forwardedRequest = forwarded instanceof Uint8Array
        ? JSON.parse(Buffer.from(forwarded.buffer, forwarded.byteOffset, forwarded.byteLength).toString('utf8')) : forwarded;
    const previous = dispatch && preceding(dispatch)[0];
    const previousLane = previous && readLane(previous.file, previous.at);
    const baseline = dispatch ? { lanes: previousLane ? { [key]: previousLane } : {} }
        : baselines.get(session) ?? createSavingsState();
    const replay = bytes && success && input.requestModified ? history.request(session + '/' + key, bytes) : undefined;
    const { state, turn } = accountSavingsTurn(baseline, { ...input, request, forwardedRequest, replay, usage,
        requestModified: success && input.requestModified });
    if (dispatch) {
        if (refused) {
            try {
                unlinkSync(dispatch.file);
            }
            catch { /* Directory already cleaned. */ }
        }
        else {
            const checkpoint = success && turn.actual_tokens && state.lanes[key];
            writeAtomically(dispatch.dir, dispatch.file, JSON.stringify(checkpoint || null));
        }
    }
    else if (!refused) {
        if (!success || !turn.actual_tokens)
            delete state.lanes[key];
        baselines.set(session, state);
        if (baselines.size > 200)
            baselines.delete(baselines.keys().next().value);
    }
    return {
        turn_id: job.id, session_id: job.sessionId, requested_at: new Date(input.nowMs).toISOString(),
        model: input.model ?? request?.model, fast_mode: turn.fast_mode, actual: turn.actual_tokens ?? null,
        plain: turn.actual_tokens ? turn.plain_tokens : null, window_crossing: success && turn.window_crossing,
    };
}
parentPort.on('message', (job) => {
    if (job.kind === 'dispatch') {
        const dispatch = checkpoint(job);
        if (dispatch)
            dispatches.set(job.id, dispatch);
        return;
    }
    let report;
    try {
        report = settle(job);
    }
    catch { /* An unusable observation cannot affect delivery. */ }
    parentPort.postMessage({ id: job.id, report });
});
//# sourceMappingURL=savings-worker.js.map