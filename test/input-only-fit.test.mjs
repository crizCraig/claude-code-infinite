// Native fit follows Anthropic's overflow rule (platform.claude.com/docs/en/
// build-with-claude/context-windows, "Context window overflow behavior"): on
// Claude 4.5 and newer only the input must fit the window; input + max_tokens
// over it is accepted and stops with "model_context_window_exceeded". ccc
// keeps a small output floor; older and unknown models keep the full
// max_tokens reservation. The 2026-10-12 incident: Anthropic accepted
// ~969k-token originals that ccc refused while MemTree's tree was stale.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";
import { OUTPUT_FLOOR_TOKENS, fitsNative, outputReservation } from "../dist/request-sizing.js";
import { fitsFallbackBudget } from "../dist/route-fallback.js";
import { acceptsContextOverflow } from "../dist/turns.js";

const WINDOW = 1_000_000;
const MAX_TOKENS = 128_000;

test("Claude 4.5+ models accept output overflow; older and unknown models do not", () => {
  for (const model of ["claude-opus-4-5", "claude-opus-4-5-20251101", "claude-opus-4-6",
    "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5[1m]",
    "claude-sonnet-4-5", "claude-sonnet-4-6", "claude-sonnet-5", "claude-sonnet-5-5",
    "claude-haiku-4-5-20251001", "claude-haiku-5-5", "claude-fable-5-1", "claude-mythos-5"]) {
    assert.equal(acceptsContextOverflow(model), true, model);
  }
  for (const model of ["claude-opus-4-1", "claude-opus-4", "claude-sonnet-4-20250514",
    "claude-3-7-sonnet-latest", "claude-haiku-3-5", "claude-x", "", undefined]) {
    assert.equal(acceptsContextOverflow(model), false, String(model));
  }
});

test("output reservation is a floor on 4.5+ and the full max_tokens otherwise", () => {
  assert.equal(OUTPUT_FLOOR_TOKENS, 16_000);
  assert.equal(outputReservation("claude-opus-4-7", MAX_TOKENS), OUTPUT_FLOOR_TOKENS);
  assert.equal(outputReservation("claude-opus-4-7", 4_000), 4_000, "never above max_tokens");
  assert.equal(outputReservation("claude-sonnet-4-20250514", MAX_TOKENS), MAX_TOKENS);
  assert.equal(outputReservation("claude-x", MAX_TOKENS), MAX_TOKENS);
  assert.equal(outputReservation(undefined, MAX_TOKENS), MAX_TOKENS);
  assert.equal(outputReservation("claude-opus-4-7", undefined), 0);
  assert.equal(outputReservation("claude-opus-4-7", -5), 0);
  assert.equal(outputReservation("claude-x", Number.NaN), 0);
});

test("native and fallback fit judge 4.5+ input against window minus the floor", () => {
  const limits = (model) => ({ budget: 500_000, context: WINDOW,
    output: outputReservation(model, MAX_TOKENS) });
  assert.equal(fitsNative(971_000, limits("claude-opus-4-7")), true);
  assert.equal(fitsNative(995_000, limits("claude-opus-4-7")), false, "floor still applies");
  assert.equal(fitsNative(971_000, limits("claude-sonnet-4-20250514")), false);
  assert.equal(fitsNative(971_000, limits("claude-x")), false);
  assert.equal(fitsFallbackBudget(971_000, MAX_TOKENS, 500_000, WINDOW, "claude-opus-4-7"), true);
  assert.equal(fitsFallbackBudget(995_000, MAX_TOKENS, 500_000, WINDOW, "claude-opus-4-7"), false);
  assert.equal(fitsFallbackBudget(971_000, MAX_TOKENS, 500_000, WINDOW, "claude-x"), false);
  assert.equal(fitsFallbackBudget(971_000, MAX_TOKENS, 500_000, WINDOW), false);
});

// Through the proxy: no Count Tokens, so delivery sizes bodies at bytes / 4.
const bodyOf = (tokens) => "x".repeat(tokens * 4);

async function serve(handler) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => handler(req, res, raw));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`,
    close() { server.closeAllConnections(); server.close(); } };
}

/** MemTree answers "stale" (index pending, compressed result still too big)
 * or "ready" (a small compressed result). */
async function harness(state) {
  const h = { state, delivered: [] };
  const upstream = await serve((req, res, raw) => {
    h.delivered.push(raw.length);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ type: "message", role: "assistant",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
  });
  const memory = await serve((req, res, raw) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") { res.statusCode = 202; return res.end("{}"); }
    if (raw && JSON.parse(raw).index_only) return res.end(JSON.stringify({ messages: [] }));
    const fit = h.state === "ready";
    h.compressCalls = (h.compressCalls ?? 0) + 1;
    const content = fit ? "saved memory ".repeat(200) : bodyOf(1_050_000);
    const messages = [{ role: "user", content }];
    res.end(JSON.stringify({ compressed: true, messages, flattened_messages: messages,
      ...(fit ? {} : { index_pending: true }),
      usage: { indexed_tokens: fit ? 990_000 : 25_000, raw_prompt_tokens: 995_000 } }));
  });
  const memtree = new MemtreeClient({ baseUrl: memory.url, apiKey: "offline" });
  h.proxy = await startProxy({ memtree, upstreamOrigin: upstream.url,
    budgetTokensOverride: 500_000, indexWaitRefreshMs: 0 });
  h.close = () => { h.proxy.close(); upstream.close(); memory.close(); };
  return h;
}

async function post(h, model, inputTokens) {
  const messages = [{ role: "user", content: bodyOf(inputTokens) },
    { role: "assistant", content: "prior" }, { role: "user", content: "next" }];
  const response = await fetch(`http://127.0.0.1:${h.proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-code-session-id": "s" },
    body: JSON.stringify({ model, max_tokens: MAX_TOKENS, messages }),
  });
  await response.text();
  return response.status;
}

for (const input of [969_000, 971_000]) {
  test(`incident replay: a stale tree forwards a ${input}-token 4.5+ original`, async () => {
    const h = await harness("stale");
    try {
      assert.equal(await post(h, "claude-opus-4-7", input), 200);
      assert.equal(h.delivered.length, 1);
      assert.ok(h.delivered[0] >= input * 4, "the original, not the compressed result");
    } finally { h.close(); }
  });
}

test("a 4.5+ input over window minus the floor is not forwarded as-is", async () => {
  const h = await harness("stale");
  try {
    assert.notEqual(await post(h, "claude-opus-4-7", 995_000), 200);
    assert.equal(h.delivered.length, 0);
    h.state = "ready";
    assert.equal(await post(h, "claude-opus-4-7", 995_000), 200);
    assert.equal(h.compressCalls, 2, "the retry asked MemTree again");
    assert.ok(h.delivered[0] < 10_000, "compressed result delivered");
  } finally { h.close(); }
});

for (const model of ["claude-sonnet-4-20250514[1m]", "claude-x[1m]"]) {
  test(`${model} keeps the full max_tokens reservation`, async () => {
    const h = await harness("stale");
    try {
      assert.notEqual(await post(h, model, 971_000), 200);
      assert.equal(h.delivered.length, 0);
    } finally { h.close(); }
  });
}
