// `ccc link <session-id>`: the session's newest MemTree page on stdout, only.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LINK_EXIT, parseLinkArgs, runLinkCommand } from "../dist/link-command.js";
import { environmentOf, subcommandArgs } from "../dist/cli-args.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const SID = "5b0c1e2a-1111-4222-8333-944455556666";
const URL_ = "https://api.polychat.co/m/0f1c2d3e4a5b";

function session(sessionId, tree = { request_id: "r1", ref: "r1@v3", links: { url: URL_ } }) {
  return { session_id: sessionId, last_at: "2026-10-17T10:00:00+00:00", latest_tree: tree };
}

/** A fetch answering each call with the next page; records the calls. */
function fakeFetch(pages) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    const page = pages[calls.length - 1];
    if (page instanceof Error) throw page;
    const { status = 200, body } = page;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { fn, calls };
}

async function run(argv, pages, extra = {}) {
  const out = [];
  const err = [];
  const { fn, calls } = fakeFetch(pages);
  const code = await runLinkCommand(argv, {
    fetch: fn, baseUrl: "https://api.polychat.co/", apiKey: "k-123", command: "ccc",
    stdout: (t) => out.push(t), stderr: (t) => err.push(t), ...extra,
  });
  return { code, stdout: out.join(""), stderr: err.join(""), calls };
}

test("prints exactly the newest tree's URL, asking the owner-only sessions listing", async () => {
  const r = await run([SID], [{ body: { sessions: [session(SID)], next_cursor: null } }]);
  assert.equal(r.code, LINK_EXIT.ok);
  assert.equal(r.stdout, `${URL_}\n`);
  assert.equal(r.stderr, "");
  assert.equal(r.calls.length, 1);
  const url = new URL(r.calls[0].url);
  assert.equal(url.origin + url.pathname, "https://api.polychat.co/v1/memtree/sessions");
  assert.equal(url.searchParams.get("q"), SID);
  assert.equal(r.calls[0].headers.authorization, "Bearer k-123");
});

test("--json prints session_id, url, tree and updated_at", async () => {
  const r = await run(["--json", SID], [{ body: { sessions: [session(SID)] } }]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), {
    session_id: SID, url: URL_, tree: "r1@v3", updated_at: "2026-10-17T10:00:00+00:00",
  });
});

test("only the exact session counts: another session quoting the id is skipped, cursors followed", async () => {
  const other = session("other-session", { request_id: "x", links: { url: "https://api.polychat.co/m/aaaaaaaaaaaa" } });
  const r = await run([SID], [
    { body: { sessions: [other], next_cursor: "c1" } },
    { body: { sessions: [session(SID)], next_cursor: null } },
  ]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `${URL_}\n`);
  assert.equal(new URL(r.calls[1].url).searchParams.get("cursor"), "c1");
});

test("no tree yet: exit 3, message on stderr, nothing on stdout", async () => {
  const noTree = await run([SID], [{ body: { sessions: [session(SID, null)], next_cursor: null } }]);
  assert.equal(noTree.code, LINK_EXIT.noTree);
  assert.equal(noTree.code, 3);
  assert.equal(noTree.stdout, "");
  assert.match(noTree.stderr, /has no MemTree yet/);
  const unknown = await run([SID], [{ body: { sessions: [], next_cursor: null } }]);
  assert.equal(unknown.code, 3);
  assert.equal(unknown.stdout, "");
});

test("no saved key: exit 1 with a hint, no request made", async () => {
  const r = await run([SID], [], { apiKey: undefined, command: "ccc staging" });
  assert.equal(r.code, LINK_EXIT.error);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /no MemTree key saved.*`ccc staging`/);
  assert.equal(r.calls.length, 0);
});

test("network error, server refusal and malformed body: exit 1, nothing on stdout", async () => {
  for (const page of [
    new TypeError("fetch failed"),
    { status: 401, body: "{\"detail\":\"bad key\"}" },
    { status: 500, body: "boom" },
    { body: "not json" },
  ]) {
    const r = await run([SID], [page]);
    assert.equal(r.code, 1, JSON.stringify(page));
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^ccc link: /);
  }
});

test("a server that never answers times out within the deadline: exit 1", async () => {
  const hang = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  });
  const out = [];
  const err = [];
  const started = Date.now();
  const code = await runLinkCommand([SID], {
    fetch: hang, baseUrl: "https://x", apiKey: "k", command: "ccc", timeoutMs: 50,
    stdout: (t) => out.push(t), stderr: (t) => err.push(t),
  });
  assert.equal(code, 1);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(out.join(""), "");
  assert.match(err.join(""), /did not answer in time/);
});

test("bad invocations are usage errors (exit 2)", async () => {
  assert.deepEqual(parseLinkArgs([SID, "--json"]), { sessionId: SID, json: true });
  assert.ok("error" in parseLinkArgs([]));
  assert.ok("error" in parseLinkArgs(["a", "b"]));
  assert.ok("error" in parseLinkArgs(["../etc"]));
  const r = await run([], []);
  assert.equal(r.code, LINK_EXIT.usage);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /usage: ccc \[staging\|local\] link/);
});

test("link is a subcommand after an environment word too, which picks the key", () => {
  assert.deepEqual(subcommandArgs(["link", SID]), { name: "link", args: [SID] });
  assert.deepEqual(subcommandArgs(["staging", "link", SID]), { name: "link", args: [SID] });
  assert.equal(environmentOf(["staging", "link"]), "staging");
  assert.equal(environmentOf(["local", "link"]), "local");
  assert.equal(environmentOf(["link"]), "production");
});

test("ccc local link with no saved key: exit 1, empty stdout (real CLI)", { timeout: 30_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-link-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CCC_NO_DIAGNOSTICS: "1" };
  const { code, stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "local", "link", SID], { env, stdio: ["ignore", "pipe", "pipe"] });
    let o = "";
    let e = "";
    child.stdout.on("data", (d) => { o += d; });
    child.stderr.on("data", (d) => { e += d; });
    child.on("error", reject);
    child.on("close", (c) => resolve({ code: c, stdout: o, stderr: e }));
  });
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(code, 1, stderr);
  assert.equal(stdout, "");
  assert.match(stderr, /no MemTree key saved.*`ccc local`/);
});
