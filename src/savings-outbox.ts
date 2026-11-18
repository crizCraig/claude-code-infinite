/** Private, immutable, single-line JSONL segments. An ack unlinks exactly its segment.
 * Multiple proxies can write and drain independently. A race to deliver is a server replay. */
import {createHash} from 'node:crypto';
import {isKeyRejected} from './key-page.js';
import {mkdir, open, readdir, readFile, rename, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {savingsReport, type SavingsRecord} from './savings-report.js';

const BATCH_SIZE = 50;
const INITIAL_DELAY = 60_000;
const MAX_DELAY = 30 * 60_000;
const SEGMENT = /^([a-f0-9-]{36})(?:\.(\d+)\.(\d+))?\.jsonl$/;

interface Segment {
  path: string;
  record: SavingsRecord;
  delay: number;
}
type Send = (turns: SavingsRecord[]) => Promise<Response>;

export class SavingsOutbox {
  private readonly directory: string;
  private readonly writes = new Set<Promise<void>>();
  private drain?: Promise<void>;
  private appendedDuringDrain = false;
  private suspended = false;

  constructor(configDir: string, baseUrl: string, key: string,
              private readonly send: Send, private readonly now: () => number) {
    const scope = createHash('sha256').update(JSON.stringify([baseUrl.replace(/\/$/, ''), key]))
      .digest('hex');
    this.directory = join(configDir, 'savings-turns', scope);
  }

  get enabled(): boolean { return !this.suspended; }

  suspend(): void {
    this.suspended = true;
  }

  append(value: unknown): void {
    if (this.suspended) return;
    let record;
    try { record = savingsReport(value); } catch { return; }
    if (!record) return;
    const writing = this.publish(record).catch(() => {});
    this.writes.add(writing);
    if (this.drain) this.appendedDuringDrain = true;
    void writing.then(() => this.writes.delete(writing));
  }

  private async publish(record: SavingsRecord): Promise<void> {
    await mkdir(this.directory, {recursive:true, mode:0o700});
    const path = join(this.directory, record.turn_id + '.jsonl');
    const file = await open(path, 'ax', 0o600);
    try {
      // One writer per segment. A reader only consumes a newline-terminated record.
      await file.appendFile(JSON.stringify(record) + '\n');
      await file.sync();
    } finally { await file.close(); }
  }

  flush(): Promise<void> {
    if (!this.drain) {
      this.drain = this.drainPending().finally(() => { this.drain = undefined; });
    }
    return this.drain;
  }

  private async drainPending(): Promise<void> {
    do {
      this.appendedDuringDrain = false;
      await this.sendPending().catch(() => {});
    } while (this.appendedDuringDrain && !this.suspended);
  }

  private async sendPending(): Promise<void> {
    await Promise.all(this.writes);
    if (this.suspended) return;
    const files = await readdir(this.directory, {withFileTypes:true});
    let batch: Segment[] = [];
    for (const entry of files) {
      if (this.suspended) break;
      const match = SEGMENT.exec(entry.name);
      if (!match || !entry.isFile() || Number(match[3] ?? 0) > this.now()) continue;
      const path = join(this.directory, entry.name);
      try {
        const line = await readFile(path, 'utf8');
        if (!line.endsWith('\n')) continue;
        const record = savingsReport(JSON.parse(line));
        if (record?.turn_id !== match[1]) continue;
        batch.push({path, record, delay:Number(match[2] ?? 0)});
      } catch { continue; } // A sibling may already have delivered the segment.
      if (batch.length === BATCH_SIZE) {
        if (!await this.sendBatch(batch)) return;
        batch = [];
      }
    }
    if (batch.length && !this.suspended) await this.sendBatch(batch);
  }

  private async sendBatch(batch: Segment[]): Promise<boolean> {
    if (this.suspended) return false;
    let ids: Set<string> = new Set();
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
    } catch { /* A lost or unreadable ack must be replayable, however old the turn. */ }
    await Promise.all(batch.map(async ({path, record, delay}) => {
      if (ids.has(record.turn_id)) {
        await unlink(path).catch(() => {});
      } else {
        // The filename carries its retry deadline across restarts. Other turns stay eligible.
        const next = Math.min(MAX_DELAY, Math.max(INITIAL_DELAY, delay * 2));
        const name = [record.turn_id, next, this.now() + next, 'jsonl'].join('.');
        await rename(path, join(this.directory, name)).catch(() => {});
      }
    }));
    return healthy;
  }
}
