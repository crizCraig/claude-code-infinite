import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MemtreeClient } from "../dist/memtree.js";
import {
  MessageRefs, REF_KEY, STORED_MESSAGES_FIELD, ackedDigests, buildDelta, missingMessageHashes,
  refFor,
} from "../dist/message-refs.js";

const VECTORS = JSON.parse(readFileSync(new URL("./fixtures/delta_vectors.json", import.meta.url)));
const hex = (value) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const imageSha = createHash("sha256").update(Buffer.from(PNG, "base64")).digest("hex");

function conversation(turns = 3) {
  const out = [
    { role: "system", content: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2; cch=1;" },
      { type: "text", text: "You are Claude Code. ".repeat(20), cache_control: { type: "ephemeral" } }] },
    { role: "user", content: [{ type: "text", text: "<system-reminder>ctx</system-reminder>" }] },
    { role: "user", content: "Fix the bug" },
  ];
  for (let i = 0; i < turns; i++) {
    out.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Read",
      input: { path: `/src/${"dir/".repeat(30)}file${i}.ts` } }] });
    out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`,
      content: i === 0 ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }]
        : `output ${i} `.repeat(200) }] });
  }
  return out;
}

test("golden vectors: the store's hash of each message and tool set, byte for byte", () => {
  assert.ok(VECTORS.length >= 8);
  for (const vector of VECTORS) {
    if (vector.tools) {
      assert.equal(hex(vector.tools), vector.memtree_ref, vector.name);
      continue;
    }
    const ref = refFor(vector.message);
    assert.equal(ref.digest, vector.ref.memtree_ref, vector.name);
    assert.deepEqual(ref.marks, vector.ref.cache_marks ?? [], vector.name);
    assert.deepEqual(ref.header, vector.ref.billing_header, vector.name);
  }
});

test("only the request's first billing header is split", () => {
  const sys = conversation()[0];
  assert.ok(refFor(sys, true).header);
  assert.equal(refFor(sys, false).header, undefined);
  assert.notEqual(refFor(sys, true).digest, refFor(sys, false).digest);
});

test("a delta names acked messages after the opening; the opening and reminders stay inline", () => {
  const messages = conversation();
  const acked = new Set(messages.map((m, i) => refFor(m, i === 0).digest));
  const delta = buildDelta(messages, acked);
  assert.equal(delta.messages[0][REF_KEY], refFor(messages[0]).digest, "system by ref");
  assert.ok(delta.messages[0].billing_header && delta.messages[0].cache_marks);
  assert.equal(delta.messages[1], messages[1], "reminder-only message before the opening");
  assert.equal(delta.messages[2], messages[2], "the opening");
  assert.ok(delta.messages.slice(3).every((m) => REF_KEY in m));
  assert.equal(delta.refs.length, messages.length - 2);
  assert.deepEqual(buildDelta(messages, new Set()), { messages, refs: [] });
  const short = [...messages, { role: "assistant", content: "ok" }];
  const shortAcked = new Set([...acked, refFor(short.at(-1)).digest]);
  assert.equal(buildDelta(short, shortAcked).messages.at(-1), short.at(-1),
    "a message shorter than its ref is sent as it is");
  const noOpening = [messages[0], messages[1]];
  assert.deepEqual(buildDelta(noOpening, acked).refs, [], "no opening: everything inline");
});

test("acks leave out unservable messages and messages holding an unserved image", () => {
  const messages = conversation();
  const all = messages.map((m, i) => refFor(m, i === 0).digest);
  const digests = ackedDigests(messages, { stored: true, messages: messages.length,
    unservable: [all[5]], unserved_images: [imageSha] });
  assert.deepEqual(digests, all.filter((_, i) => i !== 4 && i !== 5));
});

test("answers decide what is named: acks, no field, 409s, a 400", () => {
  const refs = new MessageRefs(true);
  const messages = conversation();
  const answer = { [STORED_MESSAGES_FIELD]: { stored: true, messages: messages.length,
    unservable: [], unserved_images: [] } };
  refs.noteAnswer("s", messages, answer);
  assert.equal(refs.delta("s", messages).refs.length, messages.length - 2);
  assert.equal(refs.delta("other", messages).refs.length, 0, "per session");
  refs.noteAnswer("s", messages, { [STORED_MESSAGES_FIELD]: { stored: true, messages: 1 } });
  assert.equal(refs.delta("s", messages).refs.length, messages.length - 2, "a count mismatch adds nothing");
  const sent = refs.delta("s", messages).refs;
  const body = (hashes) => JSON.stringify({ detail: { missing_message_hashes: hashes } });
  assert.ok(refs.noteRefusal("s", messages, sent, 409, body([sent[1]])));
  assert.equal(refs.delta("s", messages).refs.length, sent.length - 1, "the named one is forgotten");
  refs.noteAnswer("s", messages, answer);
  assert.equal(refs.delta("s", messages).refs.length, sent.length - 1,
    "and never acked again (a hash the server computes differently costs one 409)");
  assert.equal(refs.noteRefusal("s", messages, sent, 500, "boom"), false);
  assert.ok(refs.noteRefusal("s", messages, sent, 400,
    '{"detail":"Image references expand past the request size limit."}'), "resend only");
  assert.ok(refs.delta("s", messages).refs.length > 0);
  const next = refs.delta("s", messages).refs;
  assert.ok(refs.noteRefusal("s", messages, next, 409, body(next)), "every ref missing (kill switch)");
  refs.noteAnswer("s", messages, answer);
  assert.equal(refs.delta("s", messages).refs.length, next.length,
    "an all-missing 409 bans nothing: the next answer acks them again");
  assert.ok(refs.noteRefusal("s", messages, next, 409, body(next)));
  assert.equal(refs.delta("s", messages).refs.length, 0, "two in a row: the conversation goes in full");
  assert.ok(refs.noteRefusal("s", messages, next, 409, body(next)),
    "a call in flight when it went off is still resent");
  refs.noteAnswer("t", messages, answer);
  refs.noteAnswer("t", messages, { messages: [] }, { finalIndex: true });
  assert.ok(refs.delta("t", messages).refs.length > 0, "an exit index's early answer clears nothing");
  refs.noteAnswer("t", messages, { messages: [] });
  assert.equal(refs.delta("t", messages).refs.length, 0, "an answer without the field clears");
  refs.noteAnswer("u", messages, answer);
  assert.ok(refs.noteRefusal("u", messages, ["a".repeat(64)], 400,
    '{"detail":"Malformed message refs: x"}'));
  refs.noteAnswer("u", messages, answer);
  assert.equal(refs.delta("u", messages).refs.length, 0, "a 400 ends refs for the process");
  assert.ok(refs.noteRefusal("u", messages, ["b".repeat(64)], 409, body(["b".repeat(64)])),
    "a concurrent 409 after the 400 is still resent");
  const off = new MessageRefs(false);
  off.noteAnswer("s", messages, answer);
  assert.equal(off.delta("s", messages).refs.length, 0, "off unless enabled");
  assert.equal(missingMessageHashes("not json"), undefined);
});

test("acks are per conversation: a subagent lane's 409 leaves the main lane alone", () => {
  const refs = new MessageRefs(true);
  const main = conversation();
  const lane = [main[0], { role: "user", content: "Subagent task" }, ...main.slice(3)];
  const ack = (messages) => ({ [STORED_MESSAGES_FIELD]: { stored: true,
    messages: messages.length, unservable: [], unserved_images: [] } });
  refs.noteAnswer("s", main, ack(main));
  assert.equal(refs.delta("s", lane).refs.length, 0, "another opening names nothing");
  refs.noteAnswer("s", lane, ack(lane));
  const sent = refs.delta("s", lane).refs;
  const missing = JSON.stringify({ detail: { missing_message_hashes: sent } });
  refs.noteRefusal("s", lane, sent, 409, missing);
  refs.noteRefusal("s", lane, sent, 409, missing);
  assert.equal(refs.delta("s", lane).refs.length, 0);
  assert.equal(refs.delta("s", main).refs.length, main.length - 2, "the main lane goes on");
});

test("an opening that may be only whitespace to the server stays inline with the next", () => {
  const messages = conversation();
  messages.splice(1, 1, { role: "user", content: "<system-reminder>x</system-reminder>\u0085" });
  const acked = new Set(messages.map((m, i) => refFor(m, i === 0).digest));
  const delta = buildDelta(messages, acked);
  assert.equal(delta.messages[1], messages[1]);
  assert.equal(delta.messages[2], messages[2], "the server's opening is inline");
});

test("a client with deltas on names stored messages; a 409 sends that call in full", async () => {
  const server = await fakeMemtree();
  const records = [];
  try {
    const client = new MemtreeClient({ baseUrl: server.origin, apiKey: "k", messageRefs: true,
      reqlog: { log: (r) => records.push(r) } });
    const meta = { sessionId: "sess-1" };
    const messages = conversation(4);
    await client.compress(MemtreeClient.hashMessages(messages), messages, 200_000, undefined, meta);
    assert.match(server.bodies[0].headers["x-client-features"], /\bmessage-refs\b/);
    assert.equal(server.bodies[0].refs, 0, "nothing acked yet");
    const next = [...messages, { role: "assistant", content: "done" }];
    await client.compress(MemtreeClient.hashMessages(next), next, 200_000, undefined, meta);
    assert.ok(server.bodies[1].refs > 0 && server.bodies[1].bytes < server.bodies[0].bytes / 2);
    assert.deepEqual(server.bodies[1].rebuilt, next, "the server's rebuild is the full body");
    server.missingNext = true;
    const third = [...next, { role: "user", content: "more" }];
    assert.ok(await client.compress(MemtreeClient.hashMessages(third), third, 200_000, undefined, meta));
    assert.equal(server.bodies[2].status, 409);
    assert.equal(server.bodies[3].refs, 0, "the resend is in full");
    assert.ok(records[1].messageRefs > 0);
    assert.equal(records[2].messageRefsRefused, 409, "the resend's record says why");
    server.imageLimitNext = true;
    const fourth = [...third, { role: "assistant", content: "ok" }];
    assert.ok(await client.compress(MemtreeClient.hashMessages(fourth), fourth, 200_000, undefined, meta));
    assert.equal(server.bodies[4].status, 400);
    assert.equal(server.bodies[5].refs, 0, "served images over the cap: sent in full");
    assert.deepEqual(records.map((r) => r.ok), [true, true, true, true]);
  } finally {
    await server.close();
  }
});

test("an image-ref 409 on a delta body is sent again as the turn's ordinary body", async () => {
  const server = await fakeMemtree();
  try {
    const client = new MemtreeClient({ baseUrl: server.origin, apiKey: "k", messageRefs: true });
    const meta = { sessionId: "sess-3" };
    const messages = conversation(2);
    server.storedImages = [imageSha];
    await client.compress(MemtreeClient.hashMessages(messages), messages, 200_000, undefined, meta);
    const again = { role: "user", content: [{ type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG } }, { type: "text", text: "same" }] };
    const next = [...messages, { role: "assistant", content: "look" }, again];
    server.imageMissingNext = true;
    assert.ok(await client.compress(MemtreeClient.hashMessages(next), next, 200_000, undefined, meta));
    assert.ok(server.bodies[1].refs > 0 && server.bodies[1].imageRefs > 0);
    assert.equal(server.bodies[1].status, 409);
    assert.equal(server.bodies[2].refs, 0, "no message refs on the resend");
    assert.equal(server.bodies[2].imageRefs, 0, "the image it lacked goes as bytes");
    assert.deepEqual(server.bodies[2].rebuilt, next);
  } finally {
    await server.close();
  }
});

test("off by default: no feature declared, nothing named", async () => {
  const server = await fakeMemtree();
  try {
    const client = new MemtreeClient({ baseUrl: server.origin, apiKey: "k", messageRefs: false });
    const meta = { sessionId: "sess-2" };
    const messages = conversation(2);
    await client.compress(MemtreeClient.hashMessages(messages), messages, 200_000, undefined, meta);
    const next = [...messages, { role: "assistant", content: "ok" }];
    await client.compress(MemtreeClient.hashMessages(next), next, 200_000, undefined, meta);
    assert.doesNotMatch(server.bodies[0].headers["x-client-features"], /message-refs/);
    assert.equal(server.bodies[1].refs, 0);
  } finally {
    await server.close();
  }
});

/** A MemTree that stores every message it is sent and serves refs back from them. */
async function fakeMemtree() {
  const state = { bodies: [], store: new Map(), missingNext: false, imageLimitNext: false,
    storedImages: [], imageMissingNext: false };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const json = JSON.parse(raw);
      const refs = json.messages.filter((m) => m && REF_KEY in m);
      const entry = { headers: req.headers, bytes: Buffer.byteLength(raw), refs: refs.length,
        status: 200 };
      state.bodies.push(entry);
      const reply = (status, body) => {
        entry.status = status;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const imageRefs = raw.match(/memtree-image:sha256:[0-9a-f]{64}/g) ?? [];
      entry.imageRefs = imageRefs.length;
      if (imageRefs.length && state.imageMissingNext) {
        state.imageMissingNext = false;
        return reply(409, { detail: { message: "x",
          missing_image_sha256s: imageRefs.map((r) => r.slice(-64)) } });
      }
      if (refs.length && state.imageLimitNext) {
        state.imageLimitNext = false;
        return reply(400, { detail: "Image references expand past the request size limit." });
      }
      if (refs.length && state.missingNext) {
        state.missingNext = false;
        return reply(409, { detail: { missing_message_hashes: [refs[0][REF_KEY]] } });
      }
      const rebuilt = json.messages.map((m) => (m && REF_KEY in m ? rebuild(state.store, m) : m));
      entry.rebuilt = rebuilt;
      let headerSeen = false;
      for (const message of rebuilt) {
        const ref = refFor(message, !headerSeen);
        headerSeen = headerSeen || ref.header !== undefined;
        state.store.set(ref.digest, { message, ref });
      }
      reply(200, { messages: rebuilt, compressed: false,
        usage: { prompt_tokens: 10, completion_tokens: 1 },
        memtree_image_sha256s: state.storedImages,
        [STORED_MESSAGES_FIELD]: { stored: true, messages: rebuilt.length, tools: false,
          unservable: [], unserved_images: [] } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return Object.assign(state, {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  });
}

function rebuild(store, ref) {
  const found = store.get(ref[REF_KEY]);
  assert.ok(found, "the client named only what was stored");
  return found.message;
}
