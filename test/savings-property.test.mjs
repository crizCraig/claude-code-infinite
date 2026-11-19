import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {savingsLaneKey} from '../dist/savings.js';

const sessionId = '12345678-1234-4123-8123-123456789abc';
const model = 'claude-sonnet-4-6';
const contextWindow = 8000;
const ceiling = 6400;
const retained = 1280; // A 640-token summary plus a 640-token tail.
const workerUrl = new URL('../dist/savings-worker.js', import.meta.url);

function generator(seed) {
  let state = seed;
  return limit => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor(state / 0x100000000 * limit);
  };
}

// Integer twentieths of one input token's price avoid rounding in the oracle.
function cost(usage) {
  return 20 * usage.input + 2 * usage.cache_read + 25 * usage.cache_creation_5m
    + 40 * usage.cache_creation_1h + 100 * usage.output;
}

function measuredUsage(total, output, ttl, pick) {
  const reads = pick(total + 1);
  const writes = ttl ? pick(total - reads + 1) : 0;
  return {input_tokens:total - reads - writes, cache_read_input_tokens:reads,
    cache_creation_input_tokens:writes, cache_creation:{
      ephemeral_5m_input_tokens:ttl === '5m' ? writes : 0,
      ephemeral_1h_input_tokens:ttl === '1h' ? writes : 0}, output_tokens:output};
}

// Synthetic messages have exact, independent token weights. The oracle sees
// every dispatch and grows the *retained* conversation, even when the worker
// misses counts, misses entire requests, restarts, or receives responses late.
class Conversation {
  messages = [];
  frame = 150;
  sourceLength = 0;
  modeledLength = 0;
  lastRequest;

  request(op, pick) {
    const first = !this.messages.length;
    const newMessages = [];
    if (first || op === 'append' || op === 'large append') {
      if (!first) newMessages.push({role:'assistant', weight:10 + pick(120)});
      const weight = op === 'large append' ? ceiling + pick(1000) : 100 + pick(1000);
      newMessages.push({role:'user', weight});
    }
    if (op === 'rewrite') {
      const old = this.messages[pick(this.messages.length)];
      old.weight = 200 + pick(600);
    }
    if (op === 'reframe') this.frame = 40 + pick(900);
    this.messages.push(...newMessages);
    const original = this.frame + this.messages.reduce((n, m) => n + m.weight, 0);
    const expanded = Math.max(0, this.modeledLength + original - this.sourceLength);
    const compacted = expanded > ceiling;
    this.modeledLength = compacted ? retained : expanded;
    this.sourceLength = original;
    const appended = newMessages.reduce((n, m) => n + m.weight, 0);
    const reads = first || compacted ? 0 : Math.max(0, this.modeledLength - appended);
    const ttl = op === 'retry' ? this.lastRequest.cache_control?.ttl : ['5m', '1h', undefined][pick(3)];
    const unit = !ttl || this.modeledLength < 1024 ? 20 : ttl === '5m' ? 25 : 40;
    const inputCost = reads * 2 + (this.modeledLength - reads) * unit;
    const messages = this.messages.map(({role, weight}, i) => {
      const text = `${i} ${'x'.repeat(weight)}`;
      const content = pick(2) ? text : [{type:'text', text}];
      return {role, content};
    });
    const boundary = this.messages.findLastIndex(m => m.role === 'assistant');
    const prefixCount = boundary < 0 ? undefined : {messages:boundary,
      tokens:this.frame + this.messages.slice(0,boundary).reduce((n, m) => n + m.weight, 0)};
    const request = op === 'retry' ? this.lastRequest : {model, system:'s'.repeat(this.frame), messages,
      tools:[{name:'tool', input_schema:{type:'object', properties:{}}}],
      ...(pick(2) && {tool_choice:{type:'auto'}}),
      ...(ttl && {cache_control:{type:'ephemeral', ttl}})};
    this.lastRequest = request;
    return {request, original, inputCost, prefixCount, reads, compacted, ttl};
  }
}

async function exercise(seed, directory, coverage) {
  const pick = generator(seed);
  const conversation = new Conversation();
  const unsettled = [];
  let writer = 0;
  let worker = new Worker(workerUrl);
  let now = 1700000000000;
  let hidden = false;
  async function settle() {
    const index = pick(unsettled.length);
    if (index) coverage.add('out-of-order');
    const [item] = unsettled.splice(index, 1);
    const response = once(worker, 'message');
    worker.postMessage({kind:'settle', id:item.id, usage:item.usage, status:item.status,
      prefixCount:item.prefixCount});
    const [{report}] = await response;
    assert.ok(report, item.context);
    if (item.status === 429) {
      assert.equal(cost(report.plain), 0, item.context);
      assert.equal(cost(report.actual), 0, item.context);
    } else if (report.plain) {
      coverage.add('priced');
      assert.equal(report.actual.input + report.actual.cache_read + report.actual.cache_creation_5m
        + report.actual.cache_creation_1h, item.actualInput, item.context);
      assert.ok(cost(report.plain) <= item.maxCost,
        `${item.context} computed=${cost(report.plain)} true floor=${item.maxCost} `
        + JSON.stringify(report.plain));
    } else {
      coverage.add('pending');
    }
  }
  try {
    for (let i = 0; i < 48; i++) {
      const gap = i > 0 && pick(15) === 0;
      const op = i === 0 ? 'append' : ['append', 'retry', 'rewrite', 'reframe',
        'large append', 'append'][pick(6)];
      const {request, original, inputCost, prefixCount, reads, compacted, ttl} =
        conversation.request(op, pick);
      if (gap) {
        // Reporting is off for a launcher. Its requests reach only the oracle.
        while (unsettled.length) await settle();
        await worker.terminate();
        worker = new Worker(workerUrl);
        writer++;
        hidden = true;
        coverage.add('reporting-off');
        continue;
      }
      const modified = !!pick(2);
      const actualInput = modified ? 1 + pick(original) : original;
      const output = pick(50);
      const usage = measuredUsage(actualInput, output, ttl, pick);
      const status = pick(8) === 0 ? 429 : 200;
      const count = pick(5) ? original : undefined;
      const prefix = pick(5) ? prefixCount : undefined;
      now += 1 + pick(900000);
      const id = `${seed}-${i}`;
      const resumed = hidden || writer > 0;
      const input = {request, nowMs:now, requestModified:modified, contextWindow,
        originalInputTokens:count, possiblyResumed:resumed};
      worker.postMessage({kind:'dispatch', id, sessionId, cacheDirectory:directory,
        writer:String(writer), scope:'test', announcementFailed:false, input});
      const context = `seed=${seed} turn=${i} ${op} measured=${count !== undefined}`
        + ` compressed=${modified} hidden=${hidden} compacted=${compacted} read=${reads}`;
      unsettled.push({id, context, status, usage:status === 429 ? null : usage,
        prefixCount:prefix, maxCost:inputCost + 100 * output, actualInput});
      hidden = false;
      for (const label of [op, modified ? 'compression' : 'passthrough', String(status)]) {
        coverage.add(label);
      }
      if (compacted) coverage.add('compaction');
      if (count === undefined) coverage.add('missing count');
      if (unsettled.length >= 4 || !pick(2)) await settle();
      if (i % 17 === 16) {
        while (unsettled.length) await settle();
        await worker.terminate();
        worker = new Worker(workerUrl);
        writer++;
        coverage.add('restart');
      }
    }
    while (unsettled.length) await settle();
  } finally {
    await worker.terminate();
  }
}

test('randomized worker observations never price plain above its fully observed structural floor', async () => {
  const coverage = new Set();
  const root = await mkdtemp(join(tmpdir(), 'ccc-floor-property-'));
  try {
    for (const seed of [1, 37, 951, 22024, 987654, 0xcedc0de]) {
      await exercise(seed, join(root,String(seed)), coverage);
    }
    for (const label of ['append','retry','rewrite','reframe','compaction','restart','429',
      'compression','passthrough','missing count','out-of-order','reporting-off','priced','pending']) {
      assert.ok(coverage.has(label), `fixture did not exercise ${label}`);
    }
  } finally {
    await rm(root, {recursive:true, force:true});
  }
});

test('two launchers registering sends in either order respect the dispatch-order floor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccc-floor-registration-'));
  const workers = [new Worker(workerUrl), new Worker(workerUrl)];
  try {
    for (const [first, second] of [[0,1], [1,0]]) {
      const directory = join(root, String(first));
      const lane = join(directory, sessionId, savingsLaneKey('main'));
      await mkdir(lane, {recursive:true});
      const conversation = new Conversation();
      const pick = generator(47);
      // The early request compacts, then its byte-identical retry reads the summary.
      // Both launchers announce before either worker gets CPU to register its send.
      const sends = ['large append', 'retry'].map(op => conversation.request(op,pick));
      const reservations = workers.map((_, i) => join(lane, `pending.launcher${i}.turn${i}`));
      await Promise.all(reservations.map(file => writeFile(file, '', {mode:0o600})));
      for (const i of [first, second]) {
        const {request, original, inputCost, prefixCount} = sends[i];
        const id = `turn${i}`;
        workers[i].postMessage({kind:'dispatch', id, cacheDirectory:directory, sessionId,
          writer:`launcher${i}`, reservation:reservations[i], announcementFailed:false,
          input:{nowMs:1700000000000 + i, contextWindow, requestModified:true,
            request, originalInputTokens:original}});
        const settled = once(workers[i], 'message');
        workers[i].postMessage({kind:'settle', id, status:200, prefixCount,
          usage:{input_tokens:700, output_tokens:0}});
        const [{report}] = await settled;
        assert.equal(report.actual.input, 700);
        assert.ok(report.plain === null || cost(report.plain) <= inputCost,
          `registration ${first},${second}, dispatch ${i}: ${JSON.stringify(report)}`);
      }
    }
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    await rm(root, {recursive:true, force:true});
  }
});
