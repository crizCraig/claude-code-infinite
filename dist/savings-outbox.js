/** Private, immutable, single-line JSONL segments. An ack unlinks exactly its segment.
 * Multiple proxies can write and drain independently. A race to deliver is a server replay. */
import { createHash } from 'node:crypto';
import { isKeyRejected } from './key-page.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { LAUNCH_TIME, ownerExited } from './savings-owner.js';
import { savingsReport } from './savings-report.js';
const BATCH_SIZE = 50;
const INITIAL_DELAY = 60_000;
const MAX_DELAY = 30 * 60_000;
const SEGMENT = /^([a-f0-9-]{36})(?:\.(\d+)\.(\d+))?\.jsonl$/;
const IN_FLIGHT = /^([a-f0-9-]{36})\.([1-9]\d*)\.(\d+)\.inflight$/;
export class SavingsOutbox {
    send;
    now;
    directory;
    cacheDirectory;
    writes = new Set();
    drain;
    appendedDuringDrain = false;
    suspended = false;
    constructor(configDir, baseUrl, key, send, now) {
        this.send = send;
        this.now = now;
        const scope = createHash('sha256').update(JSON.stringify([baseUrl.replace(/\/$/, ''), key]))
            .digest('hex');
        this.directory = join(configDir, 'savings-turns', scope);
        this.cacheDirectory = join(configDir, 'savings-cache', scope);
    }
    get enabled() { return !this.suspended; }
    suspend() {
        this.suspended = true;
    }
    /** Bind both phases to this account, including turns settled after a re-key. */
    writer() {
        let inFlight;
        return Object.assign((value) => this.append(value, inFlight), {
            dispatched: (value) => {
                if (!this.enabled)
                    return;
                const record = savingsReport(value);
                if (!record)
                    return;
                const path = join(this.directory, `${record.turn_id}.${process.pid}.${LAUNCH_TIME}.inflight`);
                // The upstream send starts immediately after this callback. Only the
                // small, allowlisted identity is journaled on the forwarding thread.
                try {
                    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
                    writeFileSync(path, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
                    inFlight = path;
                }
                catch { /* A final report may still be published on settlement. */ }
            },
        });
    }
    append(value, inFlight) {
        if (this.suspended)
            return;
        let record;
        try {
            record = savingsReport(value);
        }
        catch {
            return;
        }
        if (!record)
            return;
        const writing = this.publish(record, inFlight).catch(() => { });
        this.writes.add(writing);
        if (this.drain)
            this.appendedDuringDrain = true;
        void writing.then(() => this.writes.delete(writing));
    }
    async publish(record, inFlight) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const path = join(this.directory, record.turn_id + '.jsonl');
        const staging = inFlight ? inFlight + '.settling' : path;
        const file = await open(staging, 'ax', 0o600);
        try {
            // One writer per segment. A reader only consumes a newline-terminated record.
            await file.appendFile(JSON.stringify(record) + '\n');
            await file.sync();
        }
        finally {
            await file.close();
        }
        if (inFlight) {
            // Before the first rename, a crash recovers the incomplete turn. After
            // it, the same recovery operation publishes the synced final observation.
            await rename(staging, inFlight);
            await rename(inFlight, path);
        }
    }
    flush() {
        if (!this.drain) {
            this.drain = this.drainPending().finally(() => { this.drain = undefined; });
        }
        return this.drain;
    }
    async drainPending() {
        do {
            this.appendedDuringDrain = false;
            await this.sendPending().catch(() => { });
        } while (this.appendedDuringDrain && !this.suspended);
    }
    async sendPending() {
        await Promise.all(this.writes);
        if (this.suspended)
            return;
        const files = await readdir(this.directory, { withFileTypes: true });
        let batch = [];
        for (const entry of files) {
            if (this.suspended)
                break;
            let name = entry.name;
            const interrupted = IN_FLIGHT.exec(name);
            if (interrupted && entry.isFile() && ownerExited(Number(interrupted[2]), Number(interrupted[3]))) {
                const from = join(this.directory, name);
                name = interrupted[1] + '.jsonl';
                try {
                    await rename(from, join(this.directory, name));
                }
                catch {
                    continue;
                } // A sibling recovered it first.
                await unlink(from + '.settling').catch(() => { });
            }
            const match = SEGMENT.exec(name);
            if (!match || !entry.isFile() || Number(match[3] ?? 0) > this.now())
                continue;
            const path = join(this.directory, name);
            try {
                const line = await readFile(path, 'utf8');
                if (!line.endsWith('\n'))
                    continue;
                const record = savingsReport(JSON.parse(line));
                if (record?.turn_id !== match[1])
                    continue;
                batch.push({ path, record, delay: Number(match[2] ?? 0) });
            }
            catch {
                continue;
            } // A sibling may already have delivered the segment.
            if (batch.length === BATCH_SIZE) {
                if (!await this.sendBatch(batch))
                    return;
                batch = [];
            }
        }
        if (batch.length && !this.suspended)
            await this.sendBatch(batch);
    }
    async sendBatch(batch) {
        if (this.suspended)
            return false;
        let ids = new Set();
        let healthy = false;
        try {
            const res = await this.send(batch.map(s => s.record));
            const detail = res.status === 403 ? await res.text() : '';
            if (isKeyRejected(res.status, detail) ||
                (res.status === 403 && /"detail"\s*:\s*"Individual account required"/.test(detail))) {
                this.suspend();
                return false;
            }
            if (res.ok) {
                const body = await res.json();
                if (Array.isArray(body?.acked_turn_ids)) {
                    ids = new Set(body.acked_turn_ids);
                    healthy = true;
                }
            }
        }
        catch { /* A lost or unreadable ack must be replayable, however old the turn. */ }
        await Promise.all(batch.map(async ({ path, record, delay }) => {
            if (ids.has(record.turn_id)) {
                await unlink(path).catch(() => { });
            }
            else {
                // The filename carries its retry deadline across restarts. Other turns stay eligible.
                const next = Math.min(MAX_DELAY, Math.max(INITIAL_DELAY, delay * 2));
                const name = [record.turn_id, next, this.now() + next, 'jsonl'].join('.');
                await rename(path, join(this.directory, name)).catch(() => { });
            }
        }));
        return healthy;
    }
}
//# sourceMappingURL=savings-outbox.js.map