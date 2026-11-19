import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uptime } from 'node:os';
import { ownerExited, retireReservation } from './savings-owner.js';
import { parentPort } from 'node:worker_threads';
import { readPrivateFile, writeAtomically } from './prefix-store.js';
import { acquireUpdateLock, releaseUpdateLock } from './update-lock.js';
import { accountSavingsTurn, createSavingsState, isSavingsState, normalizeSavingsUsage, refineSavingsState, savingsLaneKey } from './savings.js';
const sends = new Map();
const memory = new Map();
let evicted = false;
const waitWord = new Int32Array(new SharedArrayBuffer(4));
function empty(unknownHistory) {
    return { ...createSavingsState(), unknownHistory };
}
function readState(dir, possiblyResumed) {
    const file = join(dir, 'floor-v2.json');
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
/** Only the accounting worker waits on this lock. The cursor advances in dispatch order across launchers. */
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
            if (writeAtomically(dir, join(dir, 'floor-v2.json'), JSON.stringify(next)))
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
    memory.set(lane.key, update(dir ? { ...previous, unknownHistory: true } : previous));
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
        possiblyResumed: job.input.possiblyResumed === true };
    const input = { ...job.input, writer: job.writer, request, usage: undefined };
    const retired = [];
    const recorded = updateLane(lane, previous => {
        let uncertain = job.announcementFailed;
        if (lane.directory) {
            try {
                for (const name of readdirSync(lane.directory)) {
                    if (!name.startsWith('pending.'))
                        continue;
                    const path = join(lane.directory, name);
                    const [, writer, , pid, started] = name.split('.');
                    // Legacy announcements omitted the PID. Only a reboot proves the
                    // owner of such a reservation is gone.
                    const dead = name.endsWith('.abandoned') || (pid && started
                        ? ownerExited(Number(pid), Number(started))
                        : statSync(path).mtimeMs < Date.now() - (uptime() + 1) * 1000);
                    if (dead)
                        retired.push(path);
                    if (dead || writer !== job.writer)
                        uncertain = true;
                }
            }
            catch {
                uncertain = true;
            }
        }
        // A concurrent unregistered send can make the entire request a retry.
        const before = uncertain ? { ...previous, unknownHistory: true } : previous;
        const { state } = accountSavingsTurn(before, input);
        sends.set(job.id, { sessionId: job.sessionId, lane, input, before, dispatched: state });
        return state;
    });
    // Removing a dead reservation is safe only after the new durable cursor
    // has absorbed the possible skipped send. A crash can repeat this step.
    if (recorded) {
        if (job.reservation)
            retired.push(job.reservation);
        for (const path of retired) {
            try {
                unlinkSync(path);
            }
            catch { /* A sibling can register the same gap. */ }
        }
    }
    else if (job.reservation) {
        retireReservation(job.reservation);
    }
}
function settle({ id, usage, status, prefixCount, interruptedStream, canCount }) {
    const send = sends.get(id);
    if (!send)
        return;
    const { input, before, sessionId } = send;
    const success = status >= 200 && status < 300;
    const refused = [400, 401, 403, 404, 413, 422, 429].includes(status) ||
        (status >= 500 && status < 600 && usage == null && !interruptedStream);
    const { turn, state } = accountSavingsTurn(before, { ...input, prefixCount: prefixCount ?? input.prefixCount, usage: success ? usage : undefined });
    // Final passthrough usage settles the compaction cursor immediately, even
    // when counting this turn's retained messages still needs a round trip.
    if (success && turn.actual_tokens && !input.requestModified) {
        updateLane(send.lane, current => refineSavingsState(current, state, send.dispatched));
    }
    if (canCount && success && turn.actual_tokens && turn.prefix_messages_to_count !== undefined) {
        return { countMessages: turn.prefix_messages_to_count };
    }
    sends.delete(id);
    const zero = refused ? normalizeSavingsUsage({ input_tokens: 0, output_tokens: 0 }) : null;
    return { report: {
            turn_id: id, session_id: sessionId, requested_at: new Date(input.nowMs).toISOString(),
            model: input.model ?? input.request?.model, fast_mode: turn.fast_mode,
            actual: turn.actual_tokens ?? zero, plain: turn.actual_tokens ? turn.plain_tokens : zero,
            ...(!refused && (!turn.actual_tokens || !turn.plain_tokens) && { incomplete_reason: interruptedStream ? 'interrupted_stream' : turn.actual_tokens ? 'unmeasured_input' : 'missing_usage' }),
            window_crossing: success && turn.window_crossing,
            floor_read_possibly_uncached_tokens: turn.plain_tokens && turn.actual_tokens ? turn.floor_read_possibly_uncached_tokens : refused ? 0 : null,
            floor_read_max_gap_seconds: turn.plain_tokens && turn.actual_tokens ? turn.floor_read_max_gap_seconds : refused ? 0 : null,
        } };
}
parentPort.on('message', (job) => {
    if (job.kind === 'dispatch') {
        try {
            dispatch(job);
        }
        catch { /* Savings cannot interrupt upstream delivery. */ }
        return;
    }
    let reply;
    try {
        reply = settle(job);
    }
    catch {
        sends.delete(job.id);
    }
    parentPort.postMessage({ id: job.id, ...reply });
});
//# sourceMappingURL=savings-worker.js.map