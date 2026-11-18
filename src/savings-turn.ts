import {randomUUID} from 'node:crypto';
import {mkdir, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {savingsLaneKey, type SavingsTurnInput} from './savings.js';

type WorkerInput = Omit<SavingsTurnInput,'replay'>;
export type DispatchInput = Omit<WorkerInput,'usage'> & {possiblyResumed?:boolean};
export type SavingsJob =
  | {kind:'dispatch'; id:string; sessionId:string; scope:string; cacheDirectory?:string; writer:string; reservation?:string; announcementFailed:boolean; input:DispatchInput}
  | {kind:'settle'; id:string; usage:unknown; status:number};

// The launcher queues sends before the response can settle. The worker owns
// prompt hashing, persistence and the snapshot used to price each response.
let worker: Worker | undefined;
let writer = randomUUID();
const pending = new Map<string,(report:unknown)=>void>();
function accountingWorker(): Worker {
  if (worker) return worker;
  const current = new Worker(new URL('./savings-worker.js',import.meta.url), {execArgv:[]});
  worker = current;
  current.on('message', ({id,report}) => {
    pending.get(id)?.(report);
    pending.delete(id);
    if (!pending.size) current.unref();
  });
  current.on('error', () => { /* exit releases pending observations */ });
  current.on('exit', () => {
    worker = undefined;
    writer = randomUUID();
    for (const finish of pending.values()) finish(undefined);
    pending.clear();
  });
  current.unref();
  return current;
}

export class SavingsObservation {
  readonly id = randomUUID();
  requestedAt?: number;
  private closed = false;
  private reservation?: string;
  private announcementFailed = false;

  constructor(readonly sessionId: string, private readonly report: (value: unknown) => void,
              private readonly scope: string, private readonly cacheDirectory?: string) {}

  /** Publish an empty, private reservation before sending. Another launcher's
   * worker can now see this dispatch even if our own worker is backlogged. */
  async announce(laneKey: string): Promise<void> {
    if (!this.cacheDirectory) return;
    const dir = join(this.cacheDirectory,this.sessionId,savingsLaneKey(laneKey));
    const file = join(dir,`pending.${writer}.${this.id}`);
    try {
      await mkdir(dir,{recursive:true,mode:0o700});
      await writeFile(file,'',{flag:'wx',mode:0o600});
      this.reservation = file;
    } catch { this.announcementFailed = true; }
  }

  dispatched(input: DispatchInput): void {
    if (input.nowMs === undefined || this.requestedAt !== undefined) return;
    this.requestedAt = input.nowMs;
    try {
      accountingWorker().postMessage({kind:'dispatch', id:this.id, sessionId:this.sessionId,
        scope:this.scope, cacheDirectory:this.cacheDirectory, writer, reservation:this.reservation,
        announcementFailed:this.announcementFailed, input} satisfies SavingsJob);
    } catch { /* Forward even if the worker is unavailable. */ }
  }

  async settle(input: WorkerInput, status: number): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (input.nowMs === undefined) {
      if (this.reservation) await unlink(this.reservation).catch(() => {});
      return;
    }
    let result;
    try {
      if (this.requestedAt === undefined) {
        if (!this.reservation) await this.announce(input.laneKey ?? 'main');
        this.dispatched(input);
      }
      const current = accountingWorker();
      result = await new Promise<unknown>((resolve) => {
        current.postMessage({kind:'settle', id:this.id, usage:input.usage, status} satisfies SavingsJob);
        pending.set(this.id,resolve);
        current.ref();
      });
    } catch { /* Preserve the dispatch as incomplete if accounting failed. */ }
    this.report(result ?? {
      turn_id:this.id, session_id:this.sessionId, requested_at:new Date(input.nowMs).toISOString(),
      model:input.model ?? (input.request as {model?:string})?.model ?? 'unknown',
      fast_mode:false, window_crossing:false, actual:null, plain:null,
      floor_read_possibly_uncached_tokens:null, floor_read_max_gap_seconds:null,
    });
  }
}
