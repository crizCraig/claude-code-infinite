#!/usr/bin/env node
/**
 * The long-session test's servers, in their own process (run.mjs forks it) so that closing
 * the console, which can block the driver's event loop on Windows, never stalls them:
 *
 * - a mock Anthropic upstream that ccc forwards to (CCC_ANTHROPIC_UPSTREAM). Each turn's
 *   prompt names files: the first request of the turn gets tool_use Reads of them, the
 *   request carrying their results gets the text answer. count_tokens and every usage
 *   block report lib.mjs countBodyTokens of the body received, so Claude Code's and ccc's
 *   accounting see consistent numbers. Over the 1M window it answers 400 like Anthropic.
 * - a MemTree relay that ccc's `local` mode talks to (CCC_LOCAL_BASE_URL), forwarding every
 *   call unchanged to staging (or to a small mock MemTree when there is no key) and
 *   recording status, latency, size and the diagnostics events, never content or keys.
 *
 * Config comes as JSON in LS_SERVERS_CONFIG; records go to the events file (JSONL) and to
 * the parent over IPC.
 */
import { appendFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  BUDGET_TOKENS, CHARS_PER_TOKEN, IMAGE_REF_PREFIX, WINDOW_TOKENS, bodyImages, countBodyTokens,
  parseTurnPrompt, redactPublic, textFileContent, toolResultsIn,
} from "./lib.mjs";

const config = JSON.parse(process.env.LS_SERVERS_CONFIG ?? "{}");
const issuedTools = new Map(); // turn -> tool_use ids issued for it
let injectedOnce = false;
/** Compressions by compress calls (prepare calls not counted), and the server's budget. */
let compressionsSeen = 0;
let serverBudget;
/** The mock MemTree's image store: sha256 of the bytes -> base64. */
const mockImages = new Map();

const upstream = await listen(http.createServer((req, res) => {
  handleUpstream(req, res).catch((err) => fail(res, err));
}));
const relay = await listen(http.createServer((req, res) => {
  handleRelay(req, res).catch((err) => fail(res, err));
}));
process.send?.({ type: "ready", upstreamPort: upstream, relayPort: relay });
process.on("disconnect", () => process.exit(0));

async function handleUpstream(req, res) {
  const raw = await readBody(req);
  const url = req.url ?? "";
  if (req.method === "POST" && url.startsWith("/v1/messages/count_tokens")) {
    const tokens = countBodyTokens(JSON.parse(raw.toString("utf8")));
    record({ kind: "count", tokens, bytes: raw.length });
    return sendJson(res, 200, { input_tokens: tokens });
  }
  if (req.method === "POST" && url.startsWith("/v1/messages")) return answerMessages(raw, res);
  if (req.method === "GET" && url.startsWith("/v1/models")) {
    return sendJson(res, 200, { data: [{ id: config.model, type: "model", display_name: config.model }],
      has_more: false });
  }
  sendJson(res, 404, { type: "error", error: { type: "not_found_error", message: "mock" } });
}

async function answerMessages(raw, res) {
  const text = raw.toString("utf8");
  const body = JSON.parse(text);
  const tokens = countBodyTokens(body);
  const reply = planReply(body, text);
  const images = bodyImages(body);
  const base = { kind: "messages", lane: reply.lane, step: reply.step, turn: reply.turn,
    bytes: raw.length, tokens, images: images.count, messages: body.messages?.length ?? 0,
    flattened: text.includes("conversation_record"),
    ...(reply.toolErrors ? { toolErrors: reply.toolErrors } : {}),
    ...(reply.missingResults ? { missingResults: true } : {}) };
  if (reply.lane === "main" && tokens > WINDOW_TOKENS) {
    record({ ...base, status: 400 });
    return sendJson(res, 400, { type: "error", error: { type: "invalid_request_error",
      message: `prompt is too long: ${tokens} tokens > ${WINDOW_TOKENS} maximum` } });
  }
  record({ ...base, status: 200 });
  const message = { id: `msg_${randomBytes(8).toString("hex")}`, model: body.model,
    usage: { input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    content: reply.content, stop_reason: reply.stopReason };
  if (body.stream) return streamMessage(res, message);
  sendJson(res, 200, { ...message, type: "message", role: "assistant", stop_sequence: null,
    usage: { ...message.usage, output_tokens: outputTokens(reply.content) } });
}

/**
 * The scripted reply. A request without the Read tool or this run's turn marker is a side
 * request (titles, suggestions): a short answer. Otherwise the newest turn decides: once a
 * tool_use id issued for that turn appears anywhere in the body (structured, or inside a
 * flattened MemTree record), its results are in and the answer is text; before that, the
 * turn's Reads. Retries of the turn's first request carry no id, so they get Reads again.
 */
function planReply(body, text) {
  const hasRead = Array.isArray(body.tools) && body.tools.some((t) => t?.name === "Read");
  const prompt = hasRead ? parseTurnPrompt(text, config.runTag) : null;
  const lastText = lastUserText(body.messages);
  const side = !prompt || /\[SUGGESTION MODE:|Describe your most recent action/.test(lastText);
  if (side) {
    return { lane: "side", step: "side", content: [{ type: "text", text: "OK." }], stopReason: "end_turn" };
  }
  const ids = issuedTools.get(prompt.turn) ?? [];
  const results = toolResultsIn(body, text, ids, prompt);
  if (results.complete) {
    return { lane: "main", step: "answer", turn: prompt.turn, stopReason: "end_turn",
      toolErrors: results.errors, content: [{ type: "text", text: answerText(prompt) }] };
  }
  if (results.seen) {
    // Some of the Reads' results are missing: say so on the record, answer anyway so the
    // session goes on (the check fails the run).
    return { lane: "main", step: "answer", turn: prompt.turn, stopReason: "end_turn",
      missingResults: true, content: [{ type: "text", text: answerText(prompt) }] };
  }
  const batch = [];
  const content = prompt.files.map((name) => {
    const id = `toolu_ls${prompt.turn}_${randomBytes(6).toString("hex")}`;
    batch.push(id);
    return { type: "tool_use", id, name: "Read", input: { file_path: path.join(config.workDir, name) } };
  });
  // A retry of the turn's first request issues a fresh batch: only the newest counts.
  issuedTools.set(prompt.turn, batch);
  if (!content.length) {
    return { lane: "main", step: "answer", turn: prompt.turn, stopReason: "end_turn",
      content: [{ type: "text", text: answerText(prompt) }] };
  }
  return { lane: "main", step: "tool_use", turn: prompt.turn, content, stopReason: "tool_use" };
}

function answerText(prompt) {
  const head = `LSDONE-${config.runTag}-${prompt.turn}: read ${prompt.files.length} files.`;
  if (!prompt.answerTokens) return head;
  return `${head}\n${textFileContent(prompt.turn * 7919, prompt.answerTokens * CHARS_PER_TOKEN, "ANSWER")}`;
}

function lastUserText(messages) {
  const last = Array.isArray(messages) ? messages.at(-1) : undefined;
  if (!last || last.role !== "user") return "";
  if (typeof last.content === "string") return last.content;
  return (last.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("\n");
}

function streamMessage(res, message) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", { type: "message_start", message: { id: message.id, type: "message",
    role: "assistant", model: message.model, content: [], stop_reason: null, stop_sequence: null,
    usage: { ...message.usage, output_tokens: 1 } } });
  message.content.forEach((block, index) => {
    if (block.type === "text") {
      send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (let i = 0; i < block.text.length; i += 16_000) {
        send("content_block_delta", { type: "content_block_delta", index,
          delta: { type: "text_delta", text: block.text.slice(i, i + 16_000) } });
      }
    } else {
      send("content_block_start", { type: "content_block_start", index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      send("content_block_delta", { type: "content_block_delta", index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    send("content_block_stop", { type: "content_block_stop", index });
  });
  send("message_delta", { type: "message_delta", delta: { stop_reason: message.stop_reason,
    stop_sequence: null }, usage: { output_tokens: outputTokens(message.content) } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

function outputTokens(content) {
  return Math.max(1, Math.ceil(JSON.stringify(content).length / CHARS_PER_TOKEN));
}

/** Header names the relay passes between ccc and MemTree (never logged). */
const RELAY_REQUEST_HEADERS = ["authorization", "content-type", "accept", "x-client", "x-client-version",
  "x-client-features", "x-claude-code-session-id", "x-client-meta", "x-memtree-tools"];
const RELAY_RESPONSE_HEADERS = ["content-type", "retry-after", "x-polychat-memtree-url",
  "x-polychat-memtree-index", "x-polychat-memory-status"];

async function handleRelay(req, res) {
  // Before the body: an upload that began before the console closed must not count as after.
  const started = Date.now();
  const raw = await readBody(req);
  const pathOnly = (req.url ?? "").split("?")[0];
  // Recorded without ids: a page probe's path names a MemTree page.
  const shownPath = redactPublic(pathOnly);
  const facts = describeMemtreeRequest(pathOnly, raw, started);
  if (facts.diagnostics) record({ kind: "diagnostics", events: facts.diagnostics });
  if (shouldInject(facts)) {
    if (!facts.call.prepare) injectedOnce = true;
    record({ kind: "memtree", path: shownPath, ...facts.call, status: 503, ms: 0, injected: true });
    return sendJson(res, 503, { detail: "long-session test: injected MemTree outage" });
  }
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableFinished) abort.abort(); });
  let status;
  let answer = Buffer.alloc(0);
  let headers = {};
  try {
    ({ status, answer, headers } = config.mockMemtree
      ? mockMemtree(req, pathOnly, raw)
      : await forward(req, raw, abort.signal));
  } catch (err) {
    if (facts.call) record({ kind: "memtree", path: shownPath, ...facts.call, ms: Date.now() - started,
      error: abort.signal.aborted ? "client closed" : String(err?.cause?.code ?? err?.name ?? err) });
    if (!res.headersSent) res.writeHead(502).end();
    return;
  }
  if (facts.call) {
    record({ kind: "memtree", path: shownPath, ...facts.call, status, ms: Date.now() - started,
      responseBytes: answer.length, ...describeMemtreeAnswer(pathOnly, status, answer) });
  }
  if (res.destroyed) return;
  res.writeHead(status, headers);
  res.end(answer);
}

/** Size, kind and session of a MemTree call; the events of a diagnostics batch. */
function describeMemtreeRequest(pathOnly, raw, startedAt) {
  if (pathOnly === "/v1/ccc/diagnostics") {
    try {
      const batch = JSON.parse(raw.toString("utf8"));
      const batchId = randomBytes(4).toString("hex");
      return { diagnostics: (batch.events ?? []).map((e) => ({ name: e.name, t: e.t, code: e.code,
        signal: e.signal, status: e.status, index_only: e.index_only, ms: e.ms, batch: batchId })) };
    } catch {
      return { diagnostics: [] };
    }
  }
  if (pathOnly !== "/v1/context_memory") {
    return { call: { requestBytes: raw.length, startedAt } };
  }
  let body = {};
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    // Recorded with what is known.
  }
  const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined;
  const toolTurn = Array.isArray(last?.content) && last.content.some((b) => b?.type === "tool_result");
  return { call: { requestBytes: raw.length, startedAt, indexOnly: body.index_only === true,
    finalIndex: body.final_index === true, prepare: body.prepare === true, toolTurn,
    messages: body.messages?.length ?? 0, clientInputTokens: body.client_input_tokens,
    threshold: body.compression_threshold_tokens, ...countImages(raw) } };
}

/** Images a MemTree body carries as references and as base64 bytes. */
function countImages(raw) {
  return { imageRefs: occurrences(raw, `"${IMAGE_REF_PREFIX}`),
    base64Images: occurrences(raw, '"type":"base64"') };
}

function occurrences(buf, needle) {
  let n = 0;
  for (let at = buf.indexOf(needle); at >= 0; at = buf.indexOf(needle, at + needle.length)) n++;
  return n;
}

function describeMemtreeAnswer(pathOnly, status, answer) {
  if (pathOnly !== "/v1/context_memory" || status !== 200) return {};
  try {
    const json = JSON.parse(answer.toString("utf8"));
    if (json.model_budget_tokens > 0) serverBudget = json.model_budget_tokens;
    return { compressed: json.compressed, prepared: json.prepared === true,
      indexPending: json.index_pending === true, modelBudgetTokens: json.model_budget_tokens,
      memoryStatus: json.memory_status, storedImages: json.memtree_image_sha256s?.length ?? 0 };
  } catch {
    return { unparsed: true };
  }
}

/**
 * The cooldown exercise, an outage over the first crossing: until a compress call has
 * compressed, every prepare call fails with a 503 (so ccc has no prepared prefix to ride,
 * and a failed prepare arms nothing), and the first compress call over the budget on a
 * human turn fails once. That human turn goes out uncompressed (followup-degraded), the
 * failure arms ccc's MemTree outage cooldown, and the same turn's tool round, also over
 * the budget, skips its compress inside the cooldown (routeRecovery "cooldown"); the next
 * human turn compresses by a blocking call.
 */
function shouldInject(facts) {
  const call = facts.call;
  if (!config.injectCooldown || !call || call.indexOnly || compressionsSeen > 0) return false;
  if (call.prepare) return true;
  return !injectedOnce && !call.toolTurn &&
    (call.clientInputTokens ?? 0) >= (call.threshold ?? serverBudget ?? BUDGET_TOKENS);
}

async function forward(req, raw, signal) {
  const headers = {};
  for (const name of RELAY_REQUEST_HEADERS) {
    if (req.headers[name] !== undefined) headers[name] = req.headers[name];
  }
  const response = await fetch(`${config.memtreeBaseUrl}${req.url}`, {
    method: req.method, headers, body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : raw,
    signal,
  });
  const answer = Buffer.from(await response.arrayBuffer());
  const out = {};
  for (const name of RELAY_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) out[name] = value;
  }
  return { status: response.status, answer, headers: out };
}

/**
 * MemTree stand-in for runs without a key (and for developing the harness): passthrough
 * under the threshold, a short "memory" plus the live turn over it, index calls acked.
 */
function mockMemtree(req, pathOnly, raw) {
  const json = (status, body) => ({ status, answer: Buffer.from(JSON.stringify(body)),
    headers: { "content-type": "application/json" } });
  if (pathOnly === "/v1/context_memory/status") {
    return json(200, { valid: true, paid: true, email: "mock-e2e-test@example.invalid" });
  }
  if (pathOnly === "/v1/ccc/diagnostics") return json(200, { ok: true });
  if (pathOnly !== "/v1/context_memory" || req.method !== "POST") return json(404, { detail: "mock" });
  const body = JSON.parse(raw.toString("utf8"));
  const missing = resolveImageRefs(body);
  if (missing.length) return json(409, { detail: { missing_image_sha256s: missing } });
  const stored = { memtree_image_sha256s: storeImages(body) };
  const usage = { prompt_tokens: 1000, completion_tokens: 0, indexed_tokens: 1000,
    prompt_tokens_details: { cached_tokens: 1000 } };
  if (body.index_only) return json(200, { messages: [], usage, index_only: true, ...stored });
  const threshold = body.compression_threshold_tokens ?? BUDGET_TOKENS;
  const tokens = body.client_input_tokens ?? 0;
  if (!body.prepare && tokens < threshold) {
    return json(200, { compressed: false, messages: body.messages, usage,
      model_budget_tokens: BUDGET_TOKENS, ...stored });
  }
  return json(200, { ...mockCompression(body, usage), ...stored,
    ...(body.prepare ? { prepared: true } : {}) });
}

/** References put back as their bytes, like the server; the shas it does not store. */
function resolveImageRefs(value, missing = []) {
  if (Array.isArray(value)) {
    for (const item of value) resolveImageRefs(item, missing);
  } else if (value && typeof value === "object") {
    const data = value.type === "base64" ? value.data : undefined;
    if (typeof data === "string" && data.startsWith(IMAGE_REF_PREFIX)) {
      const sha = data.slice(IMAGE_REF_PREFIX.length);
      if (mockImages.has(sha)) value.data = mockImages.get(sha);
      else missing.push(sha);
    }
    for (const v of Object.values(value)) resolveImageRefs(v, missing);
  }
  return missing;
}

/** Stores the body's images; the shas of all of them (the answer's stored list). */
function storeImages(value, shas = []) {
  if (Array.isArray(value)) {
    for (const item of value) storeImages(item, shas);
  } else if (value && typeof value === "object") {
    if (value.type === "base64" && typeof value.data === "string") {
      const sha = createHash("sha256").update(Buffer.from(value.data, "base64")).digest("hex");
      mockImages.set(sha, value.data);
      shas.push(sha);
    }
    for (const v of Object.values(value)) storeImages(v, shas);
  }
  return shas;
}

function mockCompression(body, usage) {
  const target = body.compression_target_tokens ?? BUDGET_TOKENS / 2;
  const memory = textFileContent(17, Math.round(target * 0.6 * CHARS_PER_TOKEN), "MEMORY");
  const nonSystem = body.messages.filter((m) => m.role !== "system");
  let start = nonSystem.length - 1;
  while (start > 0 && !isHumanPrompt(nonSystem[start])) start--;
  const live = nonSystem.slice(start).map((m) => `[${m.role.toUpperCase()}]\n${blocksText(m.content)}`);
  // Like the server's: exactly one user message (ccc rejects any other flatten shape).
  const flattened = { role: "user",
    content: `⟦conversation_record⟧\n${memory}\n⟦/conversation_record⟧\n${live.join("\n\n")}` };
  const system = body.messages.filter((m) => m.role === "system");
  return { compressed: true, messages: [...system, { role: "user", content: memory }, ...nonSystem.slice(start)],
    flattened_messages: [flattened], usage, model_budget_tokens: BUDGET_TOKENS };
}

function isHumanPrompt(message) {
  if (message.role !== "user") return false;
  if (typeof message.content === "string") return true;
  return !message.content.some((b) => b?.type === "tool_result");
}

/** Blocks as the server's flatten renders them (polychat flatten_messages.py). */
function blocksText(content) {
  if (typeof content === "string") return content;
  return content.map((b) => {
    if (b.type === "text") return b.text;
    if (b.type === "image") return "[image]";
    if (b.type === "tool_result") {
      return `${b.is_error ? "→ result (error): " : "→ result: "}${blocksText(
        typeof b.content === "string" ? b.content : b.content ?? [])} (tool_use_id=${b.tool_use_id})`;
    }
    return JSON.stringify(b, (k, v) => (k === "data" ? "[image]" : v));
  }).join("\n");
}

function record(event) {
  const line = { at: Date.now(), ...event };
  if (event.kind === "memtree" && event.compressed === true && !event.prepare) compressionsSeen++;
  appendFileSync(config.eventsFile, JSON.stringify(line) + "\n");
  process.send?.({ type: "event", event: line });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function listen(server) {
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function fail(res, err) {
  record({ kind: "server_error", error: String(err?.stack ?? err).slice(0, 500) });
  if (!res.headersSent) sendJson(res, 500, { type: "error", error: { type: "api_error", message: "mock" } });
  else res.end();
}
