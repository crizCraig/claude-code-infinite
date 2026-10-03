import test from "node:test";
import assert from "node:assert/strict";
import { capCacheBreakpoints } from "../dist/route-cache.js";

const block = (text, ttl = "5m") => ({ type: "text", text, cache_control: { type: "ephemeral", ttl } });
const message = (text) => ({ role: "user", content: [block(text)] });
const count = (body) => [body.tools, body.system, ...body.messages.map((m) => m.content)]
  .flat().filter((part) => part?.cache_control).length;

test("suffix marker growth preserves every byte of a reused multi-message prefix", () => {
  const prefix = [message("flattened history"), message("earlier cached tail"), message("another cached tail")];
  const snapshot = JSON.stringify(prefix);
  const system = [block("system", "1h")];
  for (const suffixLength of [1, 3, 10]) {
    const body = {
      system: structuredClone(system), tools: [{ name: "test", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [...structuredClone(prefix), ...Array.from({ length: suffixLength }, (_, i) => message(`new suffix ${i}`))],
    };
    assert.equal(capCacheBreakpoints(body, prefix.length, { preserveSystem: true }), true);
    assert.equal(count(body), 4);
    assert.equal(JSON.stringify(body.messages.slice(0, prefix.length)), snapshot);
    assert.equal(JSON.stringify(body.system), JSON.stringify(system));
    assert.equal(JSON.stringify(prefix), snapshot, "the stored route is never modified");
  }
});

test("four prefix markers take precedence over the newest suffix marker", () => {
  const prefix = Array.from({ length: 4 }, (_, i) => message(`prefix ${i}`));
  const body = { messages: [...structuredClone(prefix), message("latest")] };
  assert.equal(capCacheBreakpoints(body, prefix.length, { preserveSystem: true }), true);
  assert.equal(count(body), 4);
  assert.equal(JSON.stringify(body.messages.slice(0, prefix.length)), JSON.stringify(prefix));
  assert.equal(body.messages[4].content[0].cache_control, undefined);
});

test("an impossible protected prefix rejects reuse without changing it", () => {
  const body = { system: [block("system", "1h")], messages: Array.from({ length: 4 }, (_, i) => message(`prefix ${i}`)) };
  const before = JSON.stringify(body);
  assert.equal(capCacheBreakpoints(body, 4, { preserveSystem: true }), false);
  assert.equal(JSON.stringify(body), before);
});

test("initial compression can remove old system/tool markers to fit its prefix", () => {
  const body = { system: [block("a"), block("b")], tools: [block("c"), block("d")], messages: [message("flatten")] };
  const prefix = JSON.stringify(body.messages);
  assert.equal(capCacheBreakpoints(body, 1), true);
  assert.equal(count(body), 4);
  assert.equal(JSON.stringify(body.messages), prefix);
});

test("trimming suffix markers never mutates the incoming request objects", () => {
  const incoming = Array.from({ length: 5 }, (_, i) => message(`incoming ${i}`));
  const before = JSON.stringify(incoming);
  const body = { messages: [message("prefix"), ...incoming] };
  assert.equal(capCacheBreakpoints(body, 1, { preserveSystem: true }), true);
  assert.equal(count(body), 4);
  assert.equal(JSON.stringify(incoming), before);
});
