import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { MemtreeClient } from "../dist/memtree.js";
import {
  IMAGE_REF_PREFIX, ImageRefs, STORED_IMAGES_FIELD, isCanonicalBase64, refusesImageRefs,
} from "../dist/image-refs.js";
import {
  IMAGE_OMITTED_TEXT, MAX_MEMTREE_BODY_BYTES, planMemtreeBody,
} from "../dist/memtree-body.js";
import { Diagnostics, DiagnosticsRequestSink } from "../dist/diagnostics.js";
import { closeBoundedMs, shutdownMemtreeDrainMs } from "../dist/cli-lifecycle.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sha = (b64) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
const png = (bytes) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"),
  randomBytes(bytes)]).toString("base64");
const image = (data) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });

/** A user image, then a screenshot inside a tool result, like Claude Code sends. */
function conversation(a, b) {
  return [
    { role: "user", content: [{ type: "text", text: "look" }, image(a)] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "shot", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1",
      content: [image(b), { type: "text", text: "ok" }] }] },
  ];
}

test("references only images the server listed, copy on write", () => {
  const a = png(300), b = png(300);
  const messages = conversation(a, b);
  const before = JSON.stringify(messages);
  const refs = new ImageRefs();
  assert.equal(refs.referenceMessages(messages).value, messages, "nothing listed yet");
  refs.noteAnswer({ messages: [] });
  assert.equal(refs.active, false, "a server without the field never gets references");
  refs.noteAnswer({ [STORED_IMAGES_FIELD]: [sha(b), "not-a-sha"] });
  const sent = refs.referenceMessages(messages);
  assert.deepEqual(sent.refs, [sha(b)]);
  assert.equal(sent.value[0], messages[0], "an unlisted image's message is the same object");
  assert.equal(sent.value[2].content[0].content[0].source.data, IMAGE_REF_PREFIX + sha(b));
  assert.equal(sent.value[2].content[0].content[0].source.media_type, "image/png");
  assert.equal(JSON.stringify(messages), before, "what is forwarded to Anthropic is untouched");
  refs.forget([sha(b)]);
  assert.equal(refs.referenceMessages(messages).refs.length, 0);
});

test("a 400 naming the key stops references; a cap 400 only resends that request", () => {
  assert.equal(refusesImageRefs(400, '{"detail":"Image references need the user\'s own MemTree key."}'), "never");
  assert.equal(refusesImageRefs(400, '{"detail":"Image references expand past the request size limit."}'), "this");
  assert.equal(refusesImageRefs(400, '{"detail":"Malformed image references."}'), "this");
  assert.equal(refusesImageRefs(400, '{"detail":"model_context_limit too small"}'), false);
  assert.equal(refusesImageRefs(409, "image references"), false);
});

test("only canonical base64 is referenced: the server re-encodes what it stores", () => {
  assert.equal(isCanonicalBase64("QQ=="), true);
  for (const data of ["QR==", "QQ", "QQ==\n", "Q Q=", "", "QQ=a"]) {
    assert.equal(isCanonicalBase64(data), false, data);
  }
  const refs = new ImageRefs();
  refs.noteAnswer({ [STORED_IMAGES_FIELD]: [sha("QR==")] });
  assert.equal(refs.referenceMessages(conversation("QR==", "QR==")).refs.length, 0);
});

test("under the limit the body is the plain JSON; over it an index call drops oldest images", () => {
  const messages = conversation(png(3000), png(3000));
  const body = { model_context_limit: 200000, index_only: true, messages };
  const plain = planMemtreeBody({ body, messages, indexOnly: true });
  assert.deepEqual(JSON.parse(plain.payload), body);
  assert.equal(plain.limit, undefined);
  const limitBytes = Buffer.byteLength(plain.payload) - 1000;
  const trimmed = planMemtreeBody({ body, messages, indexOnly: true, limitBytes });
  assert.deepEqual(trimmed.limit, { action: "trimmed", requestBytes: Buffer.byteLength(plain.payload),
    imagesDropped: 1 });
  const sent = JSON.parse(trimmed.payload).messages;
  assert.deepEqual(sent[0].content[1], { type: "text", text: IMAGE_OMITTED_TEXT }, "the oldest");
  assert.equal(sent[2].content[0].content[0].type, "image", "the newest stays");
  assert.ok(Buffer.byteLength(trimmed.payload) <= limitBytes);
  const compress = planMemtreeBody({ body, messages, indexOnly: false, limitBytes });
  assert.equal(compress.payload, undefined, "a compress call over the limit is never sent");
  assert.equal(compress.limit.action, "skipped");
  assert.equal(MAX_MEMTREE_BODY_BYTES, 30 * 1024 * 1024);
});

test("a session's later calls send stored images as references; a 409 resends bytes", async () => {
  const a = png(200_000), b = png(200_000);
  const server = await fakeMemtree();
  const records = [];
  try {
    const client = new MemtreeClient({ baseUrl: server.origin, apiKey: "k",
      reqlog: { log: (r) => records.push(r) } });
    const messages = conversation(a, b);
    server.stored = [sha(a), sha(b)];
    await client.compress(MemtreeClient.hashMessages(messages), messages, 200_000);
    assert.match(server.bodies[0].headers["x-client-features"], /\bimage-refs\b/);
    const plainBytes = server.bodies[0].bytes;
    // Next turn: both images are references, the body is a fraction of the size.
    const next = [...messages, { role: "assistant", content: "seen" }];
    await client.compress(MemtreeClient.hashMessages(next), next, 200_000);
    const second = server.bodies[1];
    assert.ok(second.bytes < plainBytes / 10, `${second.bytes} vs ${plainBytes}`);
    assert.equal(second.json.messages[0].content[1].source.data, IMAGE_REF_PREFIX + sha(a));
    // The server lost b: it names it, the same call goes again with bytes.
    server.missing = [sha(b)];
    const third = [...next, { role: "user", content: "more" }];
    const result = await client.compress(MemtreeClient.hashMessages(third), third, 200_000);
    assert.ok(result, "the resend is answered");
    assert.equal(server.bodies[2].status, 409);
    assert.equal(server.bodies[3].json.messages[2].content[0].content[0].source.data, b);
    assert.equal(server.bodies[3].json.messages[0].content[1].source.data, a, "all bytes");
    assert.deepEqual(records.map((r) => r.ok), [true, true, true]);
  } finally {
    await server.close();
  }
});

test("a resend after a slow 409 keeps the call's deadline", async () => {
  const a = png(1000);
  const server = await fakeMemtree();
  try {
    const client = new MemtreeClient({ baseUrl: server.origin, apiKey: "k" });
    const messages = conversation(a, a);
    server.stored = [sha(a)];
    await client.compress(MemtreeClient.hashMessages(messages), messages, 200_000);
    server.missing = [sha(a)];
    server.delays = [150, 150];  // the 409 and then the resend each take 150 ms
    const next = [...messages, { role: "assistant", content: "x" }];
    const started = Date.now();
    const result = await client.compress(MemtreeClient.hashMessages(next), next, 200_000,
      undefined, { timeoutMs: 200 });
    assert.equal(result, null, "the resend is cut at the 200 ms deadline, not given 200 more");
    assert.ok(Date.now() - started < 290, `${Date.now() - started} ms`);
  } finally {
    await server.close();
  }
});

test("a server that refuses references gets bytes from then on", async () => {
  const a = png(1000);
  const server = await fakeMemtree();
  try {
    const client = new MemtreeClient({ baseUrl: server.origin, apiKey: "k" });
    const messages = conversation(a, a);
    server.stored = [sha(a)];
    await client.compress(MemtreeClient.hashMessages(messages), messages, 200_000);
    server.refuse = true;
    const next = [...messages, { role: "assistant", content: "x" }];
    assert.ok(await client.compress(MemtreeClient.hashMessages(next), next, 200_000));
    server.refuse = false;
    const last = [...next, { role: "user", content: "y" }];
    await client.compress(MemtreeClient.hashMessages(last), last, 200_000);
    const statuses = server.bodies.map((body) => body.status);
    assert.deepEqual(statuses, [200, 400, 200, 200]);
    assert.ok(!JSON.stringify(server.bodies.at(-1).json).includes(IMAGE_REF_PREFIX));
  } finally {
    await server.close();
  }
});

test("the final index sends references too", async () => {
  const a = png(50_000);
  const server = await fakeMemtree();
  try {
    const client = new MemtreeClient({ baseUrl: server.origin, apiKey: "k" });
    const messages = conversation(a, a);
    server.stored = [sha(a)];
    await client.compress(MemtreeClient.hashMessages(messages), messages, 200_000);
    client.noteMainConversation("s1", { messages, modelContextLimit: 200_000,
      readReply: () => ({ role: "assistant", content: "bye" }) });
    client.flushFinalIndexes(2_000);
    assert.equal(await client.drainBackground(2_000), true);
    const final = server.bodies.at(-1).json;
    assert.equal(final.final_index, true);
    assert.equal(final.messages[0].content[1].source.data, IMAGE_REF_PREFIX + sha(a));
  } finally {
    await server.close();
  }
});

test("an exit drain that runs out reports exit_index_cut, not memtree_error", async () => {
  const server = await fakeMemtree({ hang: true });
  const records = [];
  try {
    const client = new MemtreeClient({ baseUrl: server.origin, apiKey: "k",
      reqlog: { log: (r) => records.push(r) } });
    const messages = [{ role: "user", content: "hi" }];
    client.noteMainConversation("s1", { messages, modelContextLimit: 200_000 });
    client.flushFinalIndexes(200);
    assert.equal(await client.drainBackground(200), false);
    assert.equal(records.length, 1);
    assert.equal(records[0].exitCut, true);
    assert.equal(records[0].finalIndex, true);
    const events = observed(records);
    assert.deepEqual(events.map((e) => e.name), ["exit_index_cut"]);
    assert.equal(events[0].final, true);
  } finally {
    await server.close();
  }
});

test("an exit drain cutting a call mid-body is exit_index_cut too", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"messages": [');  // headers and part of the body, then nothing
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const records = [];
  try {
    const client = new MemtreeClient({ baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: "k", reqlog: { log: (r) => records.push(r) } });
    client.noteMainConversation("s1", { messages: [{ role: "user", content: "hi" }],
      modelContextLimit: 200_000 });
    client.flushFinalIndexes(300);
    assert.equal(await client.drainBackground(300), false);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 200);
    assert.deepEqual(observed(records).map((e) => e.name), ["exit_index_cut"]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("body-limit records become memtree_body_limit, a skipped one no memtree_error", () => {
  const events = observed([
    { kind: "memtree", indexOnly: true, ms: 50, ok: true, requestBytes: 2048,
      bodyLimit: { action: "trimmed", requestBytes: 33 * 1024 * 1024, imagesDropped: 7 } },
    { kind: "memtree", indexOnly: false, ms: 0, ok: false, requestBytes: 0,
      bodyLimit: { action: "skipped", requestBytes: 40 * 1024 * 1024, imagesDropped: 0 } },
  ]);
  assert.deepEqual(events.map(({ t, ...e }) => e), [
    { name: "memtree_body_limit", action: "trimmed", index_only: true, request_kb: 33792,
      images_dropped: 7 },
    { name: "memtree_body_limit", action: "skipped", index_only: false, request_kb: 40960,
      images_dropped: 0 },
  ]);
});

test("Windows drains MemTree for 4 s; after a console close, until 3.5 s past it", () => {
  assert.equal(shutdownMemtreeDrainMs("linux", undefined), 2_000);
  assert.equal(shutdownMemtreeDrainMs("win32", undefined), 4_000);
  assert.equal(shutdownMemtreeDrainMs("win32", 10_000, 10_200), 3_300);
  assert.equal(shutdownMemtreeDrainMs("win32", 10_000, 11_000), 2_500, "proxy drain took 1 s");
  assert.equal(shutdownMemtreeDrainMs("win32", 10_000, 20_000), 0);
  // Every other step: unchanged without a close, else ended by its mark.
  assert.equal(closeBoundedMs(5_000, undefined, 1_000), 5_000);
  assert.equal(closeBoundedMs(5_000, 10_000, 1_000, 10_100), 900);
  assert.equal(closeBoundedMs(1_000, 10_000, 4_500, 14_000), 500);
});

test("trimming always ends under the limit, or skips only when nothing is left to drop", () => {
  const messages = [];
  for (let i = 0; i < 6; i++) {
    messages.push({ role: "user", content: [image(png(1000 + i * 700)), { type: "text", text: "t" }] });
  }
  const body = { model_context_limit: 200000, index_only: true, messages };
  const plain = Buffer.byteLength(planMemtreeBody({ body, messages, indexOnly: true }).payload);
  const allDropped = Buffer.byteLength(JSON.stringify({ model_context_limit: 200000,
    index_only: true, messages: messages.map((m) => ({ ...m,
      content: [{ type: "text", text: IMAGE_OMITTED_TEXT }, m.content[1]] })) }));
  for (let limitBytes = plain - 1; limitBytes > allDropped - 50; limitBytes -= 97) {
    const planned = planMemtreeBody({ body, messages, indexOnly: true, limitBytes });
    if (limitBytes >= allDropped) {
      assert.equal(planned.limit.action, "trimmed", String(limitBytes));
      assert.ok(Buffer.byteLength(planned.payload) <= limitBytes, String(limitBytes));
    } else {
      assert.equal(planned.limit.action, "skipped", String(limitBytes));
    }
  }
});

/** The events DiagnosticsRequestSink makes of `records`, as queued (not sent). */
function observed(records) {
  const diagnostics = new Diagnostics({ baseUrl: "https://x.test", clientName: "cc-infinite",
    clientVersion: "1.0.30", env: {}, config: {}, configDir: mkdtempSync(join(tmpdir(), "ccc-")),
    fetchImpl: async () => ({ ok: true, status: 202 }) });
  const sink = new DiagnosticsRequestSink(undefined, diagnostics);
  for (const record of records) sink.log(record);
  return diagnostics.queue;
}

/**
 * A MemTree that resolves references like polychat: it lists `stored` on each answer,
 * answers 409 for `missing`, 400 when `refuse`, and never answers when `hang`.
 */
async function fakeMemtree({ hang = false } = {}) {
  const state = { stored: [], missing: [], refuse: false, bodies: [], delays: [] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (hang) return;
      const json = JSON.parse(raw);
      const entry = { headers: req.headers, bytes: Buffer.byteLength(raw), json, status: 200 };
      state.bodies.push(entry);
      const refs = raw.match(/memtree-image:sha256:[0-9a-f]{64}/g) ?? [];
      const delay = state.delays.shift() ?? 0;
      const answer = (status, body) => {
        entry.status = status;
        setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        }, delay);
      };
      if (refs.length && state.refuse) {
        return answer(400, { detail: "Image references need the user's own MemTree key." });
      }
      const missing = refs.map((r) => r.slice(IMAGE_REF_PREFIX.length))
        .filter((s) => state.missing.includes(s));
      if (missing.length) {
        state.missing = [];
        return answer(409, { detail: { message: "x", missing_image_sha256s: missing } });
      }
      answer(200, { messages: json.messages, compressed: false,
        usage: { prompt_tokens: 10, completion_tokens: 1 },
        [STORED_IMAGES_FIELD]: state.stored });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return Object.assign(state, {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  });
}
