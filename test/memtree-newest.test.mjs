import test from "node:test";
import assert from "node:assert/strict";
import {
  NEWEST_TREE_TTL_MS,
  NEWEST_TREE_UNSUPPORTED_MS,
  NewestTreeLookup,
  newestTreeFrom,
  validatedTreeUrl,
} from "../dist/memtree-newest.js";

const OLD_ID = "76002072-934d-4c3e-9e41-0d5a1b2c3d4e";
const NEW_ID = "229f05e7-d2e5-4494-a631-25dd42d5759e";
const NEW_URL = `https://staging.example/usage/memtree/${NEW_ID}-v1-own`;

const item = (sessionId, requestId) => ({
  id: sessionId,
  kind: "claude_code_session",
  session_id: sessionId,
  title: `notes mentioning session-1 and ${sessionId}`,
  latest_tree: requestId
    ? {
        request_id: requestId,
        ref: `${requestId}-v1-own`,
        links: { url: `https://staging.example/usage/memtree/${requestId}-v1-own` },
      }
    : null,
});

/** A lookup over a scripted fetch: `answer(q, call)` is a body, a status, or throws. */
function scripted(answer, clock = { t: 0 }) {
  const asked = [];
  const lookup = new NewestTreeLookup(async (path) => {
    const q = new URL(path, "http://x").searchParams.get("q");
    asked.push(path);
    const a = await answer(q, asked.length - 1);
    if (typeof a === "number") return { status: a, body: Buffer.from("{}") };
    return { status: 200, body: Buffer.from(JSON.stringify(a)) };
  }, () => clock.t);
  return { lookup, asked, clock };
}

test("newestTreeFrom takes only the exact session's tree, with the server's pinned link", () => {
  const body = { sessions: [item("session-2", OLD_ID), item("session-1", NEW_ID)] };
  assert.deepEqual(newestTreeFrom(body, "session-1"), { url: NEW_URL, key: `${NEW_ID}-v1-own` });
  // `q` also matches other sessions that quote the id: never theirs.
  assert.equal(newestTreeFrom({ sessions: [item("session-2", OLD_ID)] }, "session-1"), undefined);
  assert.equal(newestTreeFrom({ sessions: [item("session-1", null)] }, "session-1"), undefined);
  assert.equal(newestTreeFrom({ detail: "Not Found" }, "session-1"), undefined);
  assert.equal(newestTreeFrom(null, "session-1"), undefined);
});

test("validatedTreeUrl preserves the server URL and rejects unsafe schemes", () => {
  assert.equal(validatedTreeUrl("https://a.b/usage/memtree/x-v1-own"), "https://a.b/usage/memtree/x-v1-own");
  assert.equal(validatedTreeUrl("https://a.b/usage/memtree/odd"), "https://a.b/usage/memtree/odd");
  assert.equal(validatedTreeUrl("javascript:alert(1)"), undefined);
  assert.equal(validatedTreeUrl("not a url"), undefined);
});

test("peek never waits: it answers from the cache and refreshes after the TTL", async () => {
  const trees = [OLD_ID, NEW_ID];
  const { lookup, asked, clock } = scripted((q, call) => ({ sessions: [item(q, trees[call])] }));
  assert.equal(lookup.peek("session-1"), undefined, "nothing cached yet");
  assert.equal((await lookup.settle("session-1")).url, `https://staging.example/usage/memtree/${OLD_ID}-v1-own`);
  lookup.peek("session-1");
  assert.equal(asked.length, 1, "fresh: no second request");
  assert.match(asked[0], /^\/v1\/memtree\/sessions\?q=session-1&limit=\d+$/);

  clock.t += NEWEST_TREE_TTL_MS;
  assert.equal(lookup.peek("session-1").url, `https://staging.example/usage/memtree/${OLD_ID}-v1-own`, "stale value served meanwhile");
  assert.equal((await lookup.settle("session-1")).url, NEW_URL);
  assert.equal(asked.length, 2);
});

test("a server without the endpoint is not asked again for a while", async () => {
  const { lookup, asked, clock } = scripted(() => 404);
  assert.equal(await lookup.settle("session-1"), undefined);
  assert.equal(await lookup.settle("session-2"), undefined);
  assert.equal(asked.length, 1);
  clock.t += NEWEST_TREE_UNSUPPORTED_MS;
  await lookup.settle("session-1");
  assert.equal(asked.length, 2);
});

test("a failed refresh keeps the last answer; a garbage session id is never sent", async () => {
  const { lookup, asked, clock } = scripted((q, call) => {
    if (call === 0) return { sessions: [item(q, NEW_ID)] };
    if (call === 1) return 500;
    throw new Error("offline");
  });
  await lookup.settle("session-1");
  clock.t += NEWEST_TREE_TTL_MS;
  assert.equal((await lookup.settle("session-1")).url, NEW_URL, "500");
  clock.t += NEWEST_TREE_TTL_MS;
  assert.equal((await lookup.settle("session-1")).url, NEW_URL, "network error");
  assert.equal(lookup.peek("../x?y"), undefined);
  assert.equal(lookup.peek(undefined), undefined);
  assert.equal(asked.length, 3);
});

test("settle gives up after its wait; the answer lands in the cache later", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { lookup, asked } = scripted(async (q) => {
    await gate;
    return { sessions: [item(q, NEW_ID)] };
  });
  assert.equal(await lookup.settle("session-1", 20), undefined);
  assert.equal(await lookup.settle("session-1", 20), undefined, "one request in flight, not two");
  assert.equal(asked.length, 1);
  release();
  assert.equal((await lookup.settle("session-1")).url, NEW_URL);
});

test("invalidate drops an in-flight answer that may predate a new compress page", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const trees = [OLD_ID, NEW_ID];
  const { lookup, asked } = scripted(async (q, call) => {
    if (call === 0) await gate;
    return { sessions: [item(q, trees[call])] };
  });
  lookup.peek("session-1");
  await new Promise((r) => setImmediate(r));
  lookup.invalidate("session-1");
  assert.equal(asked.length, 1, "invalidation does not overlap the existing fetch");
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal((await lookup.settle("session-1")).url, NEW_URL);
  assert.equal(asked.length, 2, "one replacement after the old request settles");
  assert.equal(lookup.peek("session-1").url, NEW_URL, "the overtaken answer is not stored");
});

test("finder URLs retain their pinned namespace and served/own selection", () => {
  for (const suffix of ["v1-own", "v3-served"]) {
    const row = item("session-1", NEW_ID);
    const url = `https://staging.example/usage/memtree/${NEW_ID}-${suffix}`;
    row.latest_tree.links.url = url;
    row.latest_tree.ref = `${NEW_ID}-${suffix}`;
    assert.equal(newestTreeFrom({ sessions: [row] }, "session-1").url, url);
  }
});

test("finder follows cursors past substring matches to the exact session", async () => {
  const asked = [];
  const lookup = new NewestTreeLookup(async (path) => {
    asked.push(path);
    const cursor = new URL(path, 'http://x').searchParams.get('cursor');
    return { status: 200, body: Buffer.from(JSON.stringify(cursor
      ? { sessions: [item('session-1', NEW_ID)], next_cursor: null }
      : { sessions: Array.from({length: 10}, (_, i) => item(`other-${i}`, OLD_ID)), next_cursor: 'next + / ='})) };
  });
  assert.equal((await lookup.settle('session-1'))?.key, `${NEW_ID}-v1-own`);
  assert.equal(asked.length, 2);
  assert.equal(new URL(asked[1], 'http://x').searchParams.get('cursor'), 'next + / =');
});

test("pending work is bounded across sessions and repeated invalidation", async () => {
  let calls = 0;
  const releases = [];
  const lookup = new NewestTreeLookup(() => {
    calls++;
    return new Promise(resolve => releases.push(() => resolve({ status: 200, body: Buffer.from('{"sessions":[]}') })));
  });
  lookup.peek('same-session');
  for (let i = 0; i < 1000; i++) {
    lookup.invalidate('same-session');
    lookup.peek(`session-${i}`);
  }
  await new Promise(resolve => setImmediate(resolve));
  const started = calls;
  for (const release of releases) release();
  await new Promise(resolve => setImmediate(resolve));
  for (const release of releases) release();
  assert.ok(started <= 8, `started ${started} concurrent requests`);
});

test("one deadline aborts the whole paginated lookup", async () => {
  let signal;
  const lookup = new NewestTreeLookup(async (_path, requestSignal) => {
    signal = requestSignal;
    return new Promise((resolve, reject) => requestSignal?.addEventListener('abort', () => reject(requestSignal.reason), { once: true }));
  }, Date.now, NEWEST_TREE_TTL_MS, 20);
  assert.equal(await lookup.settle('session-1', 100), undefined);
  assert.equal(signal?.aborted, true);
});

test("cursor cycles stop; exact sessions on later pages still require exact identity", async () => {
  let calls = 0;
  const lookup = new NewestTreeLookup(async () => {
    calls++;
    return {status:200, body:Buffer.from(JSON.stringify({sessions:[item('other-session',NEW_ID)],next_cursor:'repeat'}))};
  });
  assert.equal(await lookup.settle('session-1'), undefined);
  assert.equal(calls, 2);
});

test("pagination shares its abort signal and retains the last answer after a deadline", async () => {
  const signals = [];
  let phase = 'initial';
  const clock = {t:0};
  const lookup = new NewestTreeLookup(async (_path, signal) => {
    signals.push(signal);
    if (phase === 'initial') return {status:200,body:Buffer.from(JSON.stringify({sessions:[item('session-1',NEW_ID)]}))};
    if (phase === 'first-page') {
      phase = 'second-page';
      return {status:200,body:Buffer.from('{"sessions":[],"next_cursor":"page-2"}')};
    }
    return new Promise((_resolve,reject) => signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  },()=>clock.t,NEWEST_TREE_TTL_MS,20);
  await lookup.settle('session-1');
  phase = 'first-page';
  clock.t += NEWEST_TREE_TTL_MS;
  assert.equal((await lookup.settle('session-1',100)).url,NEW_URL);
  assert.equal(signals.length,3);
  assert.equal(signals[1],signals[2]);
  assert.equal(signals[2].aborted,true);
});

test("transports that ignore abort cannot accumulate beyond the concurrency cap", async () => {
  let calls = 0;
  const releases = [];
  const lookup = new NewestTreeLookup(() => {
    calls++;
    return new Promise(resolve => releases.push(() => resolve({status:200,body:Buffer.from('{"sessions":[]}')})));
  },Date.now,0,10);
  try {
    for (let i=0;i<20;i++) await lookup.settle(`session-${i}`,100);
    assert.equal(calls,8);
  } finally { for (const release of releases) release(); }
  await new Promise(resolve=>setImmediate(resolve));
});

test("completed lookup entries evict old sessions while retaining recent ones", async () => {
  const {lookup,asked} = scripted(q=>({sessions:[item(q,NEW_ID)]}));
  for(let i=0;i<205;i++) await lookup.settle(`session-${i}`);
  await lookup.settle('session-204');
  assert.equal(asked.length,205);
  await lookup.settle('session-0');
  assert.equal(asked.length,206);
});

test("production transport uses the bearer key and aborts a stalled response body", async () => {
  const http = await import('node:http');
  const {MemtreeClient} = await import('../dist/memtree.js');
  let auth, path, signal;
  const server = http.createServer((req,res)=> {
    auth=req.headers.authorization; path=req.url;
    res.writeHead(200,{'content-type':'application/json'});
    res.write('{'); // headers are ready, but the body never finishes
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client = new MemtreeClient({baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'review-test-key'});
  const lookup = new NewestTreeLookup((path,s)=> {
    signal=s;
    return client.fetchMemTree(path,'application/json',s);
  },Date.now,NEWEST_TREE_TTL_MS,100);
  try {
    assert.equal(await lookup.settle('session-1',1000),undefined);
    assert.equal(auth,'Bearer review-test-key');
    assert.equal(path,'/v1/memtree/sessions?q=session-1&limit=10');
    assert.equal(signal.aborted,true);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});
