/**
 * Shared servers for the ccc smoke tests (run.mjs):
 * - mock MemTree (/v1/context_memory) with recording + configurable failure
 * - mock Anthropic (SSE/JSON /v1/messages) with a configurable first-byte stall
 * - recording front proxy (claude → recorder → ccc proxy) to assert the ccc
 *   proxy forwards bodies byte-verbatim. Auth headers are kept IN MEMORY only.
 */

import http from "node:http";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port))
  );
}

/** Extract plain text of the last real user message (for mock compression). */
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const texts = m.content
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text);
      if (texts.length) return texts.join("\n");
    }
  }
  return "";
}

/**
 * Mock MemTree. calls[] records {indexOnly, messages, raw}. In failCompress
 * mode, non-index calls return 500 (degraded path); index calls always 200.
 */
export async function startMockMemtree({ failCompress = false } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/v1/context_memory")) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse((await readBody(req)).toString("utf-8"));
    const indexOnly = body.index_only === true;
    calls.push({ indexOnly, messages: body.messages, raw: body });

    if (!indexOnly && failCompress) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "mock compression failure" }));
      return;
    }
    const messages = indexOnly
      ? body.messages
      : [
          { role: "system", content: "You are a helpful assistant." },
          {
            role: "user",
            content:
              "MEMTREE_COMPRESSED_SENTINEL\n" +
              "Memory: the user's favorite color is teal.\n\n" +
              `User's current message: ${lastUserText(body.messages)}`,
          },
        ];
    const usage = {
      prompt_tokens: indexOnly ? 1_000 : 200_000,
      completion_tokens: indexOnly ? 1_000 : 100_000,
      prompt_tokens_details: {
        // A positive cached-token count is the production API's signal that
        // indexed history was actually used (rather than a successful no-op).
        cached_tokens: indexOnly ? 0 : 128,
      },
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ messages, usage }));
  });
  const port = await listen(server);
  return { port, calls, close: () => server.close() };
}

/**
 * Mock Anthropic. Streams a scripted SSE answer for stream:true, JSON
 * otherwise. Requests whose body contains stallOn get their response delayed
 * by stallMs to verify the proxy does not fabricate or rewrite response bytes.
 */
export async function startMockAnthropic({
  stallOn = null,
  stallMs = 11_500,
  answer = "MOCK_ANSWER_OK",
} = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = req.url ?? "";
    if (req.method === "POST" && url.startsWith("/v1/messages/count_tokens")) {
      const payload = JSON.stringify({ input_tokens: 42 });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
      return;
    }
    if (req.method === "POST" && url.startsWith("/v1/messages")) {
      requests.push({ url, body: body.toString("utf-8") });
      let parsed = {};
      try {
        parsed = JSON.parse(body.toString("utf-8"));
      } catch {}
      if (stallOn && body.includes(stallOn)) {
        await new Promise((r) => setTimeout(r, stallMs));
      }
      const model = parsed.model ?? "mock-model";
      if (parsed.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        });
        const ev = (type, data) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        ev("message_start", {
          type: "message_start",
          message: {
            id: "msg_mock_1",
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        });
        ev("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
        ev("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: answer },
        });
        ev("content_block_stop", { type: "content_block_stop", index: 0 });
        ev("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 5 },
        });
        ev("message_stop", { type: "message_stop" });
        res.end();
      } else {
        const payload = JSON.stringify({
          id: "msg_mock_1",
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: answer }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(payload);
      }
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "mock" } }));
  });
  const port = await listen(server);
  return { port, requests, close: () => server.close() };
}

/**
 * Recording front proxy: claude points here; requests are recorded then piped
 * to the ccc proxy untouched. /v1/messages headers are retained in memory
 * (never written to disk) so the thinking-round-trip spike can replay a
 * hand-crafted request with Claude Code's own auth fingerprint.
 */
export async function startRecorder(targetPort) {
  const recorded = []; // {url, body: Buffer}
  const state = { lastMessagesHeaders: null, lastMessagesUrl: null };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.method === "POST" && (req.url ?? "").startsWith("/v1/messages") &&
        !(req.url ?? "").includes("count_tokens")) {
      recorded.push({ url: req.url, body });
      state.lastMessagesHeaders = { ...req.headers };
      state.lastMessagesUrl = req.url;
    }
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, "content-length": String(body.length) },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstream.on("error", () => res.destroy());
    upstream.end(body);
  });
  server.requestTimeout = 0;
  const port = await listen(server);
  return { port, recorded, state, close: () => server.close() };
}
