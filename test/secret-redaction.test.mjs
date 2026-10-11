import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { redact, redactValue } from "../dist/secret-redaction.js";

const vectors = JSON.parse(readFileSync(new URL("./fixtures/secret_redaction_vectors.json",
  import.meta.url), "utf8")).vectors;

test("matches polychat's golden vectors exactly (shared with secret_redaction.py)", () => {
  assert.ok(vectors.length >= 60);
  vectors.forEach((v, i) => {
    const out = redact(v.input);
    assert.equal(out.text, v.output, `vector ${i}`);
    assert.deepEqual(out.counts, v.counts, `vector ${i} counts`);
  });
});

test("secret-free values come back as the same objects (payloads and hashes unchanged)", () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png",
    data: "iVBORw0KGgo" + "AKIA".repeat(5000) } };
  const messages = [
    { role: "system", content: "You are Claude Code." },
    { role: "user", content: [{ type: "text", text: "fix the bug in api_key handling" }, image] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash",
      input: { command: "grep -rn password_hash src/" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1",
      content: "src/a.py:1: password_hash = hash_pw(pw)" }] },
  ];
  const before = JSON.stringify(messages);
  const counts = {};
  assert.equal(redactValue(messages, counts), messages);
  assert.deepEqual(counts, {});
  assert.equal(JSON.stringify(messages), before);
});

test("redacts strings in tool blocks but never touches images or the input", () => {
  const key = "gh" + "p_" + "aB3dE5fG7h".repeat(4);
  const image = { type: "image", source: { type: "base64", data: "x".repeat(64) } };
  const msg = { role: "user", content: [{ type: "tool_result", tool_use_id: "t",
    content: `GITHUB_TOKEN=${key}` }, image] };
  const counts = {};
  const out = redactValue(msg, counts);
  assert.equal(out.content[0].content, "GITHUB_TOKEN=[REDACTED:github_token]");
  assert.equal(out.content[1], image);
  assert.deepEqual(counts, { github_token: 1 });
  assert.ok(msg.content[0].content.endsWith(key));
});

test("multi-MB bodies redact quickly and adversarial inputs stay linear", () => {
  const files = ["src/proxy.ts", "src/memtree.ts", "README.md"].map((f) =>
    readFileSync(new URL(`../${f}`, import.meta.url), "utf8")).join("\n");
  const body = files.repeat(Math.ceil(4e6 / files.length));
  const start = performance.now();
  redact(body);
  const ms = performance.now() - start;
  console.log(`# redact ${(body.length / 1e6).toFixed(1)} MB in ${ms.toFixed(0)} ms`);
  assert.ok(ms < 4000, `${ms} ms`);
  for (const bad of ["sk-".repeat(2e5), "a:".repeat(2e5) + "@", "password=".repeat(1e5),
    "key".repeat(2e5), "Bearer ".repeat(1e5), "-----BEGIN PRIVATE KEY-----".repeat(2e4),
    "eyJ" + "a".repeat(3e5) + "."]) {
    const t0 = performance.now();
    redact(bad);
    assert.ok(performance.now() - t0 < 1500, bad.slice(0, 12));
  }
});

test("a real-shaped session (all of src/, ~0.6 MB) without secrets is returned unchanged", async () => {
  const { readdirSync } = await import("node:fs");
  const dir = new URL("../src/", import.meta.url);
  const messages = [{ role: "system", content: "You are Claude Code." }];
  readdirSync(dir).filter((f) => f.endsWith(".ts")).forEach((f, i) => {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Read",
      input: { file_path: `/repo/src/${f}` } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`,
      content: readFileSync(new URL(f, dir), "utf8") }] });
  });
  const counts = {};
  const out = redactValue(messages, counts);
  assert.deepEqual(counts, {});
  assert.equal(out, messages);
  assert.ok(JSON.stringify(messages).length > 5e5);
});

test("CCC_REDACT_POLYCHAT=on redacts the context_memory upload; off or secret-free is unchanged",
  async (t) => {
    const http = await import("node:http");
    const { MemtreeClient } = await import("../dist/memtree.js");
    const seen = [];
    const server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => { data += c; });
      req.on("end", () => { seen.push(data); res.writeHead(200, { "content-type":
        "application/json" }); res.end("{}"); });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    const client = new MemtreeClient({ baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: "k" });
    const key = "sk-" + "ant-api03-" + "aB3dE5fG7h".repeat(6);
    const secretFree = [{ role: "user", content: "hello there" }];
    const withSecret = [{ role: "user", content: `ANTHROPIC_API_KEY=${key}` }];
    const send = async (messages, serialized) => {
      await client.callContextMemory(messages, 200000, { timeoutMs: 5000, indexOnly: true,
        serializedMessages: serialized }).catch(() => null);
      return seen.at(-1);
    };
    const previous = process.env.CCC_REDACT_POLYCHAT;
    t.after(() => { if (previous === undefined) delete process.env.CCC_REDACT_POLYCHAT;
      else process.env.CCC_REDACT_POLYCHAT = previous; });
    delete process.env.CCC_REDACT_POLYCHAT;
    const offFree = await send(secretFree);
    const offFreeSerialized = await send(secretFree, JSON.stringify(secretFree));
    const offSecret = await send(withSecret);
    assert.ok(offSecret.includes(key), "off: unchanged");
    process.env.CCC_REDACT_POLYCHAT = "on";
    assert.equal(await send(secretFree), offFree, "secret-free payload is byte-identical");
    const onSecret = await send(withSecret);
    assert.ok(!onSecret.includes(key) && onSecret.includes("[REDACTED:anthropic_key]"));
    const onSerialized = await send(withSecret, JSON.stringify(withSecret));
    assert.ok(!onSerialized.includes(key), "pre-serialized (final index) path too");
    assert.equal(await send(secretFree, JSON.stringify(secretFree)), offFreeSerialized);
  });

test("a secret mid-conversation redacts the same way every turn (server prefix hashes agree)",
  () => {
    const pw = "Qz7" + "!pw9Lm";
    const turns = [[{ role: "user", content: "deploy it" }]];
    turns.push([...turns[0], { role: "assistant", content: "Need the DB password." },
      { role: "user", content: `PGPASSWORD=${pw} run migrate` }]);
    turns.push([...turns[1], { role: "assistant", content: [{ type: "tool_use", id: "t",
      name: "Bash", input: { command: `PGPASSWORD=${pw} ./migrate.sh` } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] }]);
    const uploads = turns.map((m) => redactValue(m).map((x) => JSON.stringify(x)));
    for (let i = 1; i < uploads.length; i += 1) {
      assert.deepEqual(uploads[i].slice(0, uploads[i - 1].length), uploads[i - 1],
        `turn ${i} keeps the earlier turns' bytes`);
    }
    assert.ok(!uploads.flat().join("").includes(pw));
    assert.equal(uploads[0][0], JSON.stringify(turns[0][0]), "secret-free messages untouched");
  });
