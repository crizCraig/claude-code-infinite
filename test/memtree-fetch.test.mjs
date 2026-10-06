import test from "node:test";
import assert from "node:assert/strict";
import {
  keyForMode,
  memtreeJsonUrl,
  modeForUrl,
  runMemtreeFetchCommand,
} from "../dist/memtree-fetch.js";
import { COMPRESSED_NOTICE, compressedNoticeText } from "../dist/notices.js";

const ID = "0f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f";

test("page and .json MemTree URLs both resolve to the .json form, query intact", () => {
  assert.equal(
    memtreeJsonUrl(`https://api.polychat.co/usage/memtree/${ID}`).href,
    `https://api.polychat.co/usage/memtree/${ID}.json`
  );
  assert.equal(
    memtreeJsonUrl(`https://api.polychat.co/usage/memtree/${ID}.json?share=tok`).href,
    `https://api.polychat.co/usage/memtree/${ID}.json?share=tok`
  );
  assert.equal(
    memtreeJsonUrl(`https://api.polychat.co/usage/memtree/${ID}?share=tok`).search,
    "?share=tok"
  );
  // The short spelling the server stamps on responses.
  assert.equal(
    memtreeJsonUrl("https://app.polychat.co/m/0f1c2d3e4a5b").href,
    "https://app.polychat.co/m/0f1c2d3e4a5b.json"
  );
  assert.equal(
    memtreeJsonUrl("https://app.polychat.co/m/0f1c2d3e4a5b.json?share=tok").href,
    "https://app.polychat.co/m/0f1c2d3e4a5b.json?share=tok"
  );
});

test("non-MemTree URLs are rejected rather than fetched", () => {
  assert.equal(memtreeJsonUrl("not a url"), null);
  assert.equal(memtreeJsonUrl("https://api.polychat.co/usage?request=x"), null);
  assert.equal(memtreeJsonUrl(`https://api.polychat.co/usage/memtree/${ID}/block/0`), null);
  assert.equal(memtreeJsonUrl(`https://api.polychat.co/usage/memtree/../${ID}`), null);
  assert.equal(memtreeJsonUrl("https://app.polychat.co/m/"), null);
  assert.equal(memtreeJsonUrl("https://app.polychat.co/mx/0f1c2d3e4a5b"), null);
  assert.equal(memtreeJsonUrl(`ftp://api.polychat.co/usage/memtree/${ID}`), null);
});

test("the host picks the saved key, mirroring ccc's modes", () => {
  assert.equal(modeForUrl(new URL("https://api.polychat.co/x")), "production");
  assert.equal(
    modeForUrl(new URL("https://polychat-staging-421312241218.us-west2.run.app/x")),
    "staging"
  );
  assert.equal(modeForUrl(new URL("http://localhost:8080/x")), "local");
  assert.equal(modeForUrl(new URL("http://127.0.0.1:8080/x")), "local");
  assert.equal(modeForUrl(new URL("https://app.polychat.co/m/x")), "production");
  assert.equal(modeForUrl(new URL("http://local.polychat.co:8000/x")), "local");
  const keys = { production: "sk-prod", staging: "sk-stg", local: "" };
  assert.equal(keyForMode("staging", keys), "sk-stg");
  assert.equal(keyForMode("local", keys), undefined);
});

test("fetch sends the bearer key, prints the body, and maps outcomes to exit codes", async () => {
  const calls = [];
  let out = "";
  let err = "";
  const deps = {
    keys: { production: "sk-prod" },
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: init.headers });
      return new Response('{"nodes":[]}', { status: 200 });
    },
  };
  const code = await runMemtreeFetchCommand(
    [`https://api.polychat.co/usage/memtree/${ID}`],
    deps
  );
  assert.equal(code, 0);
  assert.equal(out, '{"nodes":[]}\n');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.polychat.co/usage/memtree/${ID}.json`);
  assert.equal(calls[0].headers.authorization, "Bearer sk-prod");
  assert.equal(calls[0].headers.accept, "application/json");

  // Server refusal: body goes to stderr, exit 1, nothing on stdout.
  out = "";
  const refused = await runMemtreeFetchCommand(
    [`https://api.polychat.co/usage/memtree/${ID}`],
    { ...deps, fetch: async () => new Response('{"detail":"nope"}', { status: 403 }) }
  );
  assert.equal(refused, 1);
  assert.equal(out, "");
  assert.match(err, /HTTP 403/);
  assert.match(err, /nope/);

  // No key saved for the host: exit 3 before any network call.
  const before = calls.length;
  const noKey = await runMemtreeFetchCommand(
    ["https://polychat-staging-421312241218.us-west2.run.app/usage/memtree/" + ID],
    deps
  );
  assert.equal(noKey, 3);
  assert.equal(calls.length, before);
  assert.match(err, /no MemTree key saved for staging/);

  // Bad invocation: usage, exit 2.
  assert.equal(await runMemtreeFetchCommand([], deps), 2);
  assert.equal(await runMemtreeFetchCommand(["https://x.y/z"], deps), 2);
});

test("the success line carries the MemTree link only when there is one to show", () => {
  assert.equal(compressedNoticeText(undefined), COMPRESSED_NOTICE);
  assert.equal(
    compressedNoticeText("https://app.polychat.co/m/0f1c2d3e4a5b"),
    `${COMPRESSED_NOTICE}\n  https://app.polychat.co/m/0f1c2d3e4a5b`
  );
});

test("a host that is not Polychat's gets no key", async () => {
  for (const host of [
    "https://evil.example",
    "https://polychat-staging.evil.example",
    "https://api.polychat.co.evil.example",
    "http://api.polychat.co",
  ]) {
    assert.equal(modeForUrl(new URL(`${host}/x`)), null, host);
  }
  let fetched = false;
  let err = "";
  const code = await runMemtreeFetchCommand([`https://evil.example/m/0f1c2d3e4a5b`], {
    keys: { production: "sk-prod", staging: "sk-stg", local: "sk-local" },
    stdout: () => {},
    stderr: (t) => (err += t),
    fetch: async () => {
      fetched = true;
      return new Response("{}");
    },
  });
  assert.equal(code, 2);
  assert.equal(fetched, false);
  assert.match(err, /not a Polychat host/);
});
