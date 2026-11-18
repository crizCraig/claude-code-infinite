import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import type {SavingsTurnInput} from './savings.js';

type WorkerInput = Omit<SavingsTurnInput,'replay'>;
export type SavingsJob =
  | {kind:'dispatch'; id:string; sessionId:string; cacheDirectory:string; laneKey:string; at:number; order:bigint}
  | {kind:'settle'; id:string; sessionId:string; scope:string; input:WorkerInput; status:number};

// One FIFO mailbox per launcher. Only the worker opens checkpoints or walks prompt
// bytes. Keep the process alive while a settled turn is on its way to the outbox.
let worker: Worker | undefined;
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

  constructor(readonly sessionId: string, private readonly report: (value: unknown) => void,
              private readonly scope: string, private readonly cacheDirectory?: string) {}

  dispatched(laneKey: string, at: number): void {
    this.requestedAt = at;
    if (this.cacheDirectory) {
      try {
        accountingWorker().postMessage({kind:'dispatch', id:this.id, sessionId:this.sessionId,
          cacheDirectory:this.cacheDirectory, laneKey, at, order:process.hrtime.bigint()} satisfies SavingsJob);
      } catch { /* Forward even if the worker is unavailable. */ }
    }
  }

  async settle(input: WorkerInput, status: number): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (input.nowMs === undefined) return;
    try {
      if (this.requestedAt === undefined) this.dispatched(input.laneKey ?? 'main', input.nowMs);
      const current = accountingWorker();
      const result = await new Promise<unknown>((resolve) => {
        current.postMessage({kind:'settle', id:this.id, sessionId:this.sessionId,
          scope:this.scope, input, status} satisfies SavingsJob);
        pending.set(this.id,resolve);
        current.ref();
      });
      if (result) this.report(result);
    } catch { /* Accounting never determines request delivery. */ }
  }
}
