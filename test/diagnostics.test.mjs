import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BATCH_SIZE,
  DIAGNOSTICS_PATH,
  Diagnostics,
  DiagnosticsRequestSink,
  INSTALL_ID_FILE,
  MAX_REPEATS,
  diagnosticsEnabled,
  environmentContext,
  recordError,
  terminalName,
} from "../dist/diagnostics.js";
import { CONTEXT_FIELDS, EVENT_FIELDS, threePartVersion } from "../dist/diagnostics-schema.js";

const KEY = "sk-polychat-user-key-0123456789abcdef";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ccc-diag-"));
}

/** A Diagnostics whose sends are captured instead of going anywhere. */
function make(overrides = {}) {
  const dir = overrides.configDir ?? tempDir();
  const sent = [];
  const fetchImpl = overrides.fetchImpl ?? (async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 202 };
  });
  const diagnostics = new Diagnostics({
    baseUrl: "https://api.example.test/", configDir: dir, clientName: "cc-infinite",
    clientVersion: "1.0.22", env: {}, config: {}, fetchImpl, now: () => 1_760_640_000_000,
    ...overrides,
  });
  return { diagnostics, sent, dir };
}

test("every opt-out turns diagnostics off: no install id, no events, no sends", async () => {
  const optOuts = [
    { env: { CCC_NO_DIAGNOSTICS: "1" } }, { env: { DO_NOT_TRACK: "1" } },
    { env: { DISABLE_TELEMETRY: "true" } },
    { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } },
    { config: { diagnostics: false } },
  ];
  for (const optOut of optOuts) {
    const { diagnostics, sent, dir } = make(optOut);
    assert.equal(diagnostics.enabled, false, JSON.stringify(optOut));
    diagnostics.record("first_run");
    diagnostics.start();
    await diagnostics.flush(50);
    assert.equal(sent.length, 0);
    assert.equal(existsSync(join(dir, INSTALL_ID_FILE)), false);
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(diagnosticsEnabled({ DO_NOT_TRACK: "0" }, {}), true);
  assert.equal(diagnosticsEnabled({}, { diagnostics: true }), true);
});

test("install id: created once, owner-only, first run reported only then", () => {
  const dir = tempDir();
  const first = make({ configDir: dir }).diagnostics;
  assert.equal(first.firstRun, true);
  const id = readFileSync(join(dir, INSTALL_ID_FILE), "utf-8").trim();
  assert.match(id, /^[0-9a-f-]{36}$/);
  if (process.platform !== "win32") {
    assert.equal(statSync(join(dir, INSTALL_ID_FILE)).mode & 0o777, 0o600);
  }
  const second = make({ configDir: dir }).diagnostics;
  assert.equal(second.firstRun, false);
  assert.equal(JSON.parse(second.batchBody([])).install_id, id);
});

test("batches: POST to the endpoint, key only in the authorization header", async () => {
  const { diagnostics, sent } = make({ apiKey: KEY });
  for (let i = 0; i < BATCH_SIZE + 3; i++) diagnostics.record("session_start", { source: "startup" });
  await diagnostics.flush(1000);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, `https://api.example.test${DIAGNOSTICS_PATH}`);
  assert.equal(sent[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(sent[0].body.events.length, BATCH_SIZE);
  assert.equal(sent[1].body.events.length, 3);
  assert.equal(sent[0].body.schema, 1);
  assert.ok(!sent[0].init.body.includes(KEY));
  const anonymous = make();
  anonymous.diagnostics.record("first_run");
  await anonymous.diagnostics.flush(1000);
  assert.equal(anonymous.sent[0].init.headers.authorization, undefined);
});

test("the queue is capped and a failed or hanging send never throws or blocks", async () => {
  const { diagnostics } = make({
    maxQueue: 3, fetchImpl: () => new Promise(() => {}),
  });
  for (let i = 0; i < 10; i++) diagnostics.record("first_run");
  assert.equal(diagnostics.dropped, 7);
  const started = Date.now();
  await diagnostics.flush(50);
  assert.ok(Date.now() - started < 1000, "the shutdown flush is bounded");
  const failing = make({ fetchImpl: async () => { throw new Error("offline"); } });
  failing.diagnostics.record("first_run");
  failing.diagnostics.flushNow();
  await failing.diagnostics.flush(100);
});

test("unknown events and fields are dropped before queueing", async () => {
  const { diagnostics, sent } = make();
  diagnostics.record("prompt_submitted", { text: "hello" });
  diagnostics.record("constructor", {});
  diagnostics.record("__proto__", {});
  diagnostics.record("key_status", { result: "invalid", status: 401, key: KEY, extra: 1 });
  diagnostics.record("upstream_error", { status: "401", turn_type: "made-up", request_kb: 12.4 });
  await diagnostics.flush(1000);
  assert.deepEqual(sent[0].body.events, [
    { result: "invalid", status: 401, name: "key_status", t: 1_760_640_000_000 },
    { request_kb: 12, name: "upstream_error", t: 1_760_640_000_000 },
  ]);
});

test("the request-log tee: records pass through unchanged; first request, first turn, errors", async () => {
  const { diagnostics, sent } = make();
  const seen = [];
  const sink = new DiagnosticsRequestSink({ log: (r) => seen.push(r) }, diagnostics);
  const probe = { kind: "messages", turnType: "side-request", requestBytes: 2048, upstreamStatus: 401,
                  totalMs: 120, client: { billingHeader: true, ccVersion: "2.1.301.241", promptId: false,
                  tools: 0, suspectedSideRequest: true } };
  sink.log(probe);
  sink.log({ ...probe, turnType: "first-user", upstreamStatus: 200,
             client: { ...probe.client, turnOrigin: "human" } });
  for (let i = 0; i < MAX_REPEATS + 4; i++) sink.log(probe);
  sink.log({ kind: "memtree", indexOnly: false, ms: 900, ok: false, status: 402, requestBytes: 5000 });
  sink.log({ kind: "messages", turnType: "followup-degraded", requestBytes: 10, compress: { ms: 30000, ok: false, timedOut: true } });
  sink.log({ kind: "notice", event: "claimed", via: "Stop" });
  assert.equal(seen.length, MAX_REPEATS + 9);
  assert.equal(seen[0], probe);
  await diagnostics.flush(1000);
  const names = sent.flatMap((s) => s.body.events.map((e) => e.name));
  assert.equal(names.filter((n) => n === "first_request").length, 1);
  assert.equal(names.filter((n) => n === "first_turn").length, 1);
  assert.equal(names.filter((n) => n === "upstream_error").length, MAX_REPEATS);
  assert.ok(names.includes("memtree_error") && names.includes("compress_timeout"));
  assert.equal(sent[0].body.context.cc_version, "2.1.301");
  const first = sent[0].body.events[0];
  assert.deepEqual(first, { status: 401, turn_type: "side-request", total_ms: 120, request_kb: 2,
                            name: "first_request", t: 1_760_640_000_000 });
});

test("a throwing inner log or observer never breaks the tee's caller", () => {
  const { diagnostics } = make();
  const sink = new DiagnosticsRequestSink(undefined, diagnostics);
  sink.log({ kind: "messages", turnType: "tool", requestBytes: 1, get client() { throw new Error("x"); } });
});

test("errors travel as fixed-vocabulary codes only", async () => {
  const { diagnostics, sent } = make();
  const known = Object.assign(new Error("open '/Users/zelda/secret.txt'"), { code: "ENOENT" });
  const custom = Object.assign(new Error("x"), { code: "PRIVATE_PROJECT", name: "CustomerSecretError" });
  recordError(diagnostics, "spawn_failed", known);
  recordError(diagnostics, "spawn_failed", custom);
  diagnostics.record("error", { code: "spawn_failed", errno: "PRIVATE_PROJECT", error_name: "CustomerSecretError" });
  await diagnostics.flush(1000);
  const events = sent[0].body.events.map(({ t, ...e }) => e);
  assert.deepEqual(events, [
    { code: "spawn_failed", errno: "ENOENT", error_name: "Error", name: "error" },
    { code: "spawn_failed", errno: "other", error_name: "other", name: "error" },
    { code: "spawn_failed", name: "error" },
  ]);
});

test("environment context maps every value onto an allowed shape", () => {
  const ctx = environmentContext({ TERM_PROGRAM: "/Users/alice/bin/my-term", WSL_DISTRO_NAME: "Ubuntu" }, "1.0.22");
  assert.equal(ctx.terminal, "other");
  assert.equal(ctx.ccc_version, "1.0.22");
  assert.equal(terminalName({ TERM_PROGRAM: "iterm.app" }), "iTerm.app");
  assert.equal(terminalName({}), "none");
  assert.equal(threePartVersion("2.1.301.241"), "2.1.301");
  assert.equal(threePartVersion("10.20.30.40"), "10.20.30");
});

// ---------------------------------------------------------------------------
// No content ever leaves: property tests
// ---------------------------------------------------------------------------

const USER = "zelda-q-hartwell";
const SECRETS = [
  `/Users/${USER}/src/acme-payroll-service/src/billing/invoice.ts`,
  `C:\\Users\\${USER}\\Documents\\acme-merger\\notes.txt`,
  `/home/${USER}/work/kubernetes-prod-secrets/values.yaml`,
  "Please refactor the payroll calculator and never mention the Hartwell acquisition",
  "Summarize this contract: confidential settlement amount of 4.2 million",
  "sk-ant-api03-Zq9xV1bN2mL3kJ4hG5fD6sA7pO8iU9yT0rE1wQ2zX3cV4bN5mL6kJ7hG8fD9sA0",
  "sk-ant-oat01-ZYXWVUTSRQPONMLKJIHGFEDCBA0123456789abcdefghijk",
  KEY,
  "ghp_R4nd0mT0k3nV4lu3F0rT3st1ngPurp0s3sXyZ12",
  "AKIAZ7ZZTESTKEY12345",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ6ZWxkYSJ9.c2lnbmF0dXJlLXZhbHVlLWhlcmU",
  `${USER}@acme-corp.example`,
  "build-runner-17.acme-corp.internal",
  "10.42.17.201",
  "https://memtree.dev/m/0f9e8d7c6b5a4f3e2d1c",
  "git@github.com:acme-corp/acme-payroll-service.git",
  "feature/hartwell-acquisition-cleanup",
  "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
];

/** Deterministic PRNG so a failure is reproducible. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

/** Distinctive pieces: any one surviving in the payload counts as a leak. */
function fragments(secret) {
  return secret.match(/[A-Za-z0-9]{6,}/g)?.filter((w) => !/^(Users|Documents|https|github)$/i.test(w)) ?? [secret];
}

const ALL_FIELDS = [
  ...new Set([...Object.keys(CONTEXT_FIELDS), ...Object.values(EVENT_FIELDS).flatMap(Object.keys),
              "text", "prompt", "path", "cwd", "message", "url", "hostname", "user", "key"]),
];

function stuffed(rand, secret) {
  const fields = {};
  for (const field of ALL_FIELDS) if (rand() < 0.7) fields[field] = rand() < 0.8 ? secret : [secret];
  return fields;
}

function realisticRecords(rand, secret) {
  return [
    { kind: "messages", turnType: pick(rand, ["first-user", "tool", secret]), requestBytes: Math.floor(rand() * 9e6),
      model: secret, userAgent: secret, upstreamStatus: pick(rand, [200, 400, 401, 429, 529]),
      ttfbMs: Math.floor(rand() * 5000), totalMs: Math.floor(rand() * 60000),
      client: { billingHeader: true, ccVersion: pick(rand, ["2.1.301.241", secret]), entrypoint: secret,
                turnOrigin: pick(rand, ["human", secret, undefined]), promptId: true, tools: 12,
                suspectedSideRequest: rand() < 0.5, systemHead: secret },
      transcript: { ok: false, head: secret }, compress: { ms: 100, ok: false, timedOut: rand() < 0.5 },
      history: { retainedChars: 1, priorHistoryChars: 2, usable: true }, memtreeUrl: secret },
    { kind: "memtree", indexOnly: rand() < 0.5, ms: 10, ok: false, status: pick(rand, [402, 500, undefined]),
      requestBytes: 123, model: secret, memtreeUrl: secret, memtreeIndex: secret },
    { kind: "notice", event: "claimed", via: "Stop", text: secret },
  ];
}

/** Every value on the wire; keys and event names are allowlist vocabulary, not content. */
function wireValues(body) {
  const batch = JSON.parse(body);
  const events = batch.events.map(({ name, ...rest }) => Object.values(rest));
  return JSON.stringify([batch.install_id, Object.values(batch.context), events]);
}

function errorCarrying(secret) {
  const err = new Error(`ENOENT: no such file or directory, open '${secret}'`);
  err.code = secret;
  err.name = secret;
  err.path = secret;
  return err;
}

test("no content ever leaves: random events, records, errors and context carry none of it", async () => {
  const rand = rng(20261016);
  for (let round = 0; round < 60; round++) {
    const secret = pick(rand, SECRETS);
    const { diagnostics, sent } = make({ apiKey: KEY, env: { TERM_PROGRAM: secret, LANG: secret, USER } });
    const sink = new DiagnosticsRequestSink({ log() {} }, diagnostics);
    diagnostics.setContext(stuffed(rand, secret));
    for (let i = 0; i < 12; i++) {
      diagnostics.record(pick(rand, [...Object.keys(EVENT_FIELDS), secret]), stuffed(rand, secret));
      for (const record of realisticRecords(rand, secret)) sink.log(record);
      recordError(diagnostics, pick(rand, ["spawn_failed", secret]), errorCarrying(secret));
    }
    await diagnostics.flush(1000);
    assert.ok(sent.length > 0);
    for (const { init } of sent) {
      const outgoing = `${wireValues(init.body)}\n${JSON.stringify({ ...init.headers, authorization: undefined })}`;
      for (const fragment of fragments(secret)) {
        if (secret === KEY) continue; // the key is checked below: only its own header carries it
        assert.ok(!outgoing.includes(fragment), `round ${round}: "${fragment}" of "${secret}" leaked`);
      }
      assert.ok(!init.body.includes(KEY), "the MemTree key never goes in the body");
      assert.ok(!init.body.includes(USER), "the username never leaves");
    }
  }
});

test("no content ever leaves: only allowlisted keys and value shapes reach the wire", async () => {
  const rand = rng(7);
  const { diagnostics, sent } = make();
  const sink = new DiagnosticsRequestSink(undefined, diagnostics);
  for (let i = 0; i < 40; i++) {
    const secret = pick(rand, SECRETS);
    diagnostics.record(pick(rand, Object.keys(EVENT_FIELDS)), stuffed(rand, secret));
    for (const record of realisticRecords(rand, secret)) sink.log(record);
  }
  await diagnostics.flush(1000);
  for (const { body } of sent) {
    assert.deepEqual(Object.keys(body).sort(), ["context", "events", "install_id", "schema"]);
    for (const key of Object.keys(body.context)) assert.ok(key in CONTEXT_FIELDS, key);
    for (const event of body.events) {
      const allowed = EVENT_FIELDS[event.name];
      assert.ok(allowed, event.name);
      for (const [key, value] of Object.entries(event)) {
        if (key === "name" || key === "t") continue;
        assert.ok(key in allowed, `${event.name}.${key}`);
        if (typeof value === "string") assert.ok(value.length <= 40 && !/[\s/\\@:]/.test(value), value);
      }
    }
  }
});
