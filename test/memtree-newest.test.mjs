import test from "node:test";
import assert from "node:assert/strict";
import {
  NEWEST_TREE_TTL_MS,
  NEWEST_TREE_UNSUPPORTED_MS,
  NewestTreeLookup,
  newestTreeFrom,
  shortTreeUrl,
} from "../dist/memtree-newest.js";

const OLD_ID = "76002072-934d-4c3e-9e41-0d5a1b2c3d4e";
const NEW_ID = "229f05e7-d2e5-4494-a631-25dd42d5759e";
const NEW_URL = "https://staging.example/m/229f05e7d2e5";

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

test("newestTreeFrom takes only the exact session's tree, as a short link", () => {
  const body = { sessions: [item("session-2", OLD_ID), item("session-1", NEW_ID)] };
  assert.deepEqual(newestTreeFrom(body, "session-1"), { url: NEW_URL, key: `${NEW_ID}-v1-own` });
  // `q` also matches other sessions that quote the id: never theirs.
  assert.equal(newestTreeFrom({ sessions: [item("session-2", OLD_ID)] }, "session-1"), undefined);
  assert.equal(newestTreeFrom({ sessions: [item("session-1", null)] }, "session-1"), undefined);
  assert.equal(newestTreeFrom({ detail: "Not Found" }, "session-1"), undefined);
  assert.equal(newestTreeFrom(null, "session-1"), undefined);
});

test("shortTreeUrl keeps the server's origin and the 12-hex short id", () => {
  assert.equal(shortTreeUrl("https://a.b/usage/memtree/x-v1-own", NEW_ID), "https://a.b/m/229f05e7d2e5");
  assert.equal(shortTreeUrl("https://a.b/usage/memtree/odd", "not-a-uuid"), "https://a.b/usage/memtree/odd");
  assert.equal(shortTreeUrl("javascript:alert(1)", NEW_ID), undefined);
  assert.equal(shortTreeUrl("not a url", NEW_ID), undefined);
});

test("peek never waits: it answers from the cache and refreshes after the TTL", async () => {
  const trees = [OLD_ID, NEW_ID];
  const { lookup, asked, clock } = scripted((q, call) => ({ sessions: [item(q, trees[call])] }));
  assert.equal(lookup.peek("session-1"), undefined, "nothing cached yet");
  assert.equal((await lookup.settle("session-1")).url, "https://staging.example/m/76002072934d");
  lookup.peek("session-1");
  assert.equal(asked.length, 1, "fresh: no second request");
  assert.match(asked[0], /^\/v1\/memtree\/sessions\?q=session-1&limit=\d+$/);

  clock.t += NEWEST_TREE_TTL_MS;
  assert.equal(lookup.peek("session-1").url, "https://staging.example/m/76002072934d", "stale value served meanwhile");
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
  lookup.invalidate("session-1");
  assert.equal(asked.length, 2, "asked again at once");
  assert.equal((await lookup.settle("session-1")).url, NEW_URL);
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(lookup.peek("session-1").url, NEW_URL, "the overtaken answer is not stored");
});
