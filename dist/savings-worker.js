import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
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
    catch { /* The filename still gives us its dispatch time. */ }
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
        const older = readdirSync(dir).flatMap(name => {
            const match = checkpointName.exec(name);
            if (!match)
                return [];
            const time = Number(match[1]), tie = match[2] ?? '';
            return time < at || (time === at && tie < sequence) ? [{ name, time, tie }] : [];
        }).sort((a, b) => b.time - a.time || b.tie.localeCompare(a.tie));
        const dispatch = { dir, file };
        if (!older.length)
            return dispatch;
        const previous = older[0];
        const previousFile = join(dir, previous.name);
        dispatch.previous = { file: previousFile, at: previous.time, lane: readLane(previousFile, previous.time) };
        for (const { name } of older.slice(1)) {
            try {
                unlinkSync(join(dir, name));
            }
            catch { /* A sibling pruned it. */ }
        }
        return dispatch;
    }
    catch { /* Missing cache evidence falls back to the observed median. */ }
}
function settle(job) {
    const dispatch = dispatches.get(job.id);
    dispatches.delete(job.id);
    const { input, status } = job;
    const session = job.scope + '/' + job.sessionId;
    const lane = input.laneKey ?? 'main';
    const key = savingsLaneKey(lane);
    const success = status >= 200 && status < 300;
    const usage = success ? input.usage : [400, 401, 403, 404, 413, 422, 429].includes(status)
        ? { input_tokens: 0, output_tokens: 0 } : undefined;
    const bytes = input.request instanceof Uint8Array
        ? Buffer.from(input.request.buffer, input.request.byteOffset, input.request.byteLength) : undefined;
    const request = bytes ? JSON.parse(bytes.toString('utf8')) : input.request;
    const previous = dispatch?.previous;
    // The predecessor can settle while this response is streaming.
    const previousLane = previous && (previous.lane ?? readLane(previous.file, previous.at));
    const baseline = dispatch ? { lanes: previousLane ? { [key]: previousLane } : {} }
        : baselines.get(session) ?? createSavingsState();
    const replay = bytes && success && input.requestModified ? history.request(session + '/' + key, bytes) : undefined;
    const { state, turn } = accountSavingsTurn(baseline, { ...input, request, replay, usage,
        requestModified: success && input.requestModified, previousAt: previous?.at, unverifiedPredecessor: !!previous && !previousLane });
    if (success && turn.actual_tokens) {
        if (dispatch) {
            const lane = state.lanes[key];
            if (isSavingsLane(lane, lane.at))
                writeAtomically(dispatch.dir, dispatch.file, JSON.stringify(lane));
        }
        else {
            baselines.set(session, state);
            if (baselines.size > 200)
                baselines.delete(baselines.keys().next().value);
        }
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