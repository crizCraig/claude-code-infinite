import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";
import { RequestLogger } from "../dist/reqlog.js";

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => server.close(),
      });
    });
  });
}

/** Mock Anthropic upstream: always a 200 non-streaming message. */
function mockUpstream() {
  return listen((req, res) => {
    req.resume();
    req.on("end", () => {
      const body = JSON.stringify({
        type: "message",
        id: "msg_upstream",
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: "upstream answer" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 42, output_tokens: 7 },
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      });
      res.end(body);
    });
  });
}

/** Mock MemTree server answering every /v1/context_memory POST the same way. */
async function mockMemtree(status, bodyObj) {
  const calls = [];
  const srv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      const body = JSON.stringify(bodyObj);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
  });
  return { ...srv, calls };
}

async function postMessages(port, messages) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-x", max_tokens: 64, messages }),
  });
  return res.json();
}

/** Followup user turn: an earlier real user input exists → blocking compress. */
const followupTurn = (question) => [
  { role: "user", content: "first question" },
  { role: "assistant", content: [{ type: "text", text: "first answer" }] },
  { role: "user", content: question },
];

/** Tool turn: last message is a tool_result wrapper → background index only. */
const toolTurn = [
  { role: "user", content: "first question" },
  { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
];

async function waitFor(cond, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Parsed JSONL records currently in the log file ([] while absent/empty). */
function readRecords(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function tempLogPath() {
  return join(mkdtempSync(join(tmpdir(), "ccc-reqlog-")), "requests.jsonl");
}

test("proxied /v1/messages requests each append a JSONL record", async () => {
  const logPath = tempLogPath();
  const reqlog = new RequestLogger(logPath);
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed" }],
    usage: { prompt_tokens_details: { cached_tokens: 123 } },
  });
  const memtree = new MemtreeClient({
    baseUrl: memtreeSrv.origin,
    apiKey: "k",
    reqlog,
  });
  const proxy = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin,
    reqlog,
  });
  try {
    // Tool turn → forwardRaw path.
    await postMessages(proxy.port, toolTurn);
    // Followup user turn → blocking compress → forwardWithNotices path.
    const armed = await fetch(proxy.hookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "session-log",
        prompt_id: "prompt-log",
        prompt: "turn two",
      }),
    });
    assert.equal(armed.status, 204);
    await postMessages(proxy.port, followupTurn("turn two"));
    const displayed = await fetch(proxy.hookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "MessageDisplay",
        session_id: "session-log",
        prompt_id: "prompt-log",
        turn_id: "turn-log",
        message_id: "message-log",
        index: 0,
        final: true,
        delta: "upstream answer",
      }),
    });
    assert.equal(displayed.status, 200);

    // Writes are fire-and-forget; poll until both /v1/messages records plus
    // MemTree records and the notice-claim record have landed.
    let records = [];
    await waitFor(() => {
      records = readRecords(logPath);
      return (
        records.filter((r) => r.kind === "messages").length >= 2 &&
        records.filter((r) => r.kind === "memtree").length >= 2 &&
        records.filter((r) => r.kind === "notice").length === 1
      );
    });

    const [toolRec, followupRec] = records.filter((r) => r.kind === "messages");
    assert.equal(toolRec.turnType, "tool");
    assert.equal(toolRec.model, "claude-x");
    assert.equal(toolRec.stream, false);
    assert.equal(toolRec.upstreamStatus, 200);
    assert.ok(toolRec.requestBytes > 0);
    assert.equal(toolRec.forwardedBytes, toolRec.requestBytes, "verbatim forward");
    assert.equal(toolRec.approxInputTokens, Math.round(toolRec.forwardedBytes / 4));
    assert.ok(typeof toolRec.totalMs === "number");
    assert.ok(!Number.isNaN(Date.parse(toolRec.ts)), "ts is ISO");
    assert.equal(toolRec.compress, undefined, "no blocking compress on tool turns");

    assert.equal(followupRec.turnType, "followup-compressed");
    assert.equal(followupRec.upstreamStatus, 200);
    assert.ok(followupRec.compress.ok);
    assert.equal(followupRec.compress.timedOut, false);
    assert.ok(typeof followupRec.compress.ms === "number");
    assert.ok(
      followupRec.forwardedBytes < followupRec.requestBytes,
      "compressed body forwarded"
    );
    // Non-streaming JSON path extracts real usage from the response body.
    assert.equal(followupRec.usage.input_tokens, 42);
    assert.equal(followupRec.usage.output_tokens, 7);

    const memtreeRecs = records.filter((r) => r.kind === "memtree");
    assert.ok(memtreeRecs.some((r) => r.indexOnly === true), "background index logged");
    assert.ok(memtreeRecs.some((r) => r.indexOnly === false), "compress logged");
    for (const r of memtreeRecs) {
      assert.equal(r.ok, true);
      assert.equal(r.status, 200);
      assert.ok(r.requestBytes > 0);
      assert.ok(typeof r.ms === "number");
    }

    const [noticeRec] = records.filter((r) => r.kind === "notice");
    assert.equal(noticeRec.event, "claimed");
    assert.equal(noticeRec.via, "MessageDisplay");
    assert.ok(!Number.isNaN(Date.parse(noticeRec.ts)), "notice ts is ISO");
    assert.deepEqual(Object.keys(noticeRec).sort(), [
      "event",
      "kind",
      "ts",
      "via",
    ]);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("proxy drain cancels a stalled raw turn and logs it before returning", async () => {
  const records = [];
  let markUpstreamStarted;
  const upstreamStarted = new Promise((resolve) => {
    markUpstreamStarted = resolve;
  });
  let stalledResponse;
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      stalledResponse = res;
      markUpstreamStarted();
      // Deliberately never respond. Forced proxy drain owns cancellation.
    });
  });
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "unused" }],
  });
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (record) => records.push(structuredClone(record)) },
  });
  const clientDone = fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-x",
      max_tokens: 64,
      messages: [{ role: "user", content: "first question" }],
    }),
  }).then(
    (response) => response.text().then(() => undefined),
    () => undefined
  );

  try {
    await upstreamStarted;
    let guard;
    const complete = await Promise.race([
      proxy.drain(1),
      new Promise((_, reject) => {
        guard = setTimeout(
          () => reject(new Error("proxy drain did not force-cancel raw request")),
          1_000
        );
      }),
    ]).finally(() => clearTimeout(guard));

    assert.equal(complete, false, "the grace deadline forced cancellation");
    const messageRecords = records.filter((record) => record.kind === "messages");
    assert.equal(messageRecords.length, 1, "request finalizer ran before drain returned");
    assert.equal(messageRecords[0].turnType, "first-user");
    assert.equal(typeof messageRecords[0].totalMs, "number");
    await waitFor(() => stalledResponse.destroyed);
    await clientDone;
  } finally {
    stalledResponse?.destroy();
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("unwritable log path never breaks proxying", async () => {
  // A regular FILE where the log's parent dir should be: mkdir and every
  // append fail. The logger must swallow that and the proxy must still work.
  const blocker = join(mkdtempSync(join(tmpdir(), "ccc-reqlog-")), "not-a-dir");
  writeFileSync(blocker, "occupied");
  const reqlog = new RequestLogger(join(blocker, "requests.jsonl"));

  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed" }],
  });
  const memtree = new MemtreeClient({
    baseUrl: memtreeSrv.origin,
    apiKey: "k",
    reqlog,
  });
  const proxy = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin,
    reqlog,
  });
  try {
    const toolResp = await postMessages(proxy.port, toolTurn);
    assert.equal(toolResp.content[0].text, "upstream answer");
    const followupResp = await postMessages(proxy.port, followupTurn("turn two"));
    assert.equal(followupResp.content[0].text, "upstream answer");
    // Give the fire-and-forget appends a beat to fail, then prove nothing
    // was created where the directory should be.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(readFileSync(blocker, "utf-8"), "occupied");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("RequestLogger.flush waits for scheduled JSONL appends", async () => {
  const logPath = tempLogPath();
  const reqlog = new RequestLogger(logPath);
  reqlog.log({ kind: "notice", event: "claimed", via: "Stop" });

  assert.equal(await reqlog.flush(1_000), true);
  assert.deepEqual(
    readRecords(logPath).map(({ ts: _ts, ...record }) => record),
    [{ kind: "notice", event: "claimed", via: "Stop" }]
  );
});

test("MemtreeClient shutdown aborts and logs background indexes before flush", async () => {
  const logPath = tempLogPath();
  const reqlog = new RequestLogger(logPath);
  let calls = 0;
  const memtreeSrv = await listen((req, _res) => {
    calls++;
    // Consume the request but deliberately never answer. Shutdown must abort
    // this producer instead of letting its finally-log race a later flush.
    req.resume();
  });
  const memtree = new MemtreeClient({
    baseUrl: memtreeSrv.origin,
    apiKey: "k",
    reqlog,
  });

  try {
    memtree.indexInBackground("first", toolTurn, 200_000);
    await waitFor(() => calls === 1);

    assert.equal(await memtree.drainBackground(0), false, "stalled call was aborted");
    assert.equal(await reqlog.flush(1_000), true);
    const recordsAtFlush = readRecords(logPath);
    assert.equal(recordsAtFlush.length, 1);
    assert.deepEqual(
      recordsAtFlush.map(({ ts: _ts, ms: _ms, ...record }) => record),
      [{
        kind: "memtree",
        indexOnly: true,
        ok: false,
        requestBytes: recordsAtFlush[0].requestBytes,
      }]
    );

    // Draining closes the producer lifecycle: even a distinct hash cannot
    // start a call (and therefore cannot append anything after the flush).
    memtree.indexInBackground("second", toolTurn, 200_000);
    assert.equal(
      await memtree.drainBackground(0),
      true,
      "no post-flush producer was accepted"
    );
    assert.equal(calls, 1);
    assert.deepEqual(readRecords(logPath), recordsAtFlush);
  } finally {
    memtreeSrv.close();
  }
});

test("oversized log rotates to .1 at startup, overwriting any previous .1", () => {
  const logPath = tempLogPath();
  writeFileSync(`${logPath}.1`, "old rotation\n");
  writeFileSync(logPath, Buffer.alloc(21 * 1024 * 1024, 0x61)); // > 20MB

  new RequestLogger(logPath);

  assert.ok(existsSync(`${logPath}.1`));
  assert.equal(statSync(`${logPath}.1`).size, 21 * 1024 * 1024, "big file became .1");
  assert.ok(!existsSync(logPath), "fresh log starts on next append");
});

test("small log is left in place at startup", () => {
  const logPath = tempLogPath();
  writeFileSync(logPath, '{"ts":"x"}\n');
  new RequestLogger(logPath);
  assert.equal(readFileSync(logPath, "utf-8"), '{"ts":"x"}\n');
  assert.ok(!existsSync(`${logPath}.1`));
});
