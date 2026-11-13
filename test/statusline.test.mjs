// `ccc statusline`: the session's MemTree link in Claude Code's status line, from a cached
// file only (status-link.ts, statusline.ts); install wraps the user's own command.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StatusLinkFiles, readStatusLink } from "../dist/status-link.js";
import {
  STATUSLINE_COMMAND, installStatusline, linkSegment, renderStatusline, uninstallStatusline,
} from "../dist/statusline.js";
import {
  NEWEST_TREE_CURRENT_WAIT_MS, NEWEST_TREE_FETCH_TIMEOUT_MS, NewestTreeLookup,
} from "../dist/memtree-newest.js";

const URL1 = "https://memtree.ai/m/a8f362de";
const URL2 = "https://memtree.ai/m/b9f0";
const SESSION = "e32c1f3e-f811-468a-8d31-e4967cbf1219";
const ITERM = { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.7.0" };
const APPLE_TERMINAL = { TERM_PROGRAM: "Apple_Terminal" };
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccc-statusline-"));
}

test("link files: written on change, read back, unsafe ids never name a file", () => {
  const dir = tmp();
  const files = new StatusLinkFiles(dir);
  files.write(SESSION, URL1);
  assert.equal(readStatusLink(SESSION, dir), URL1);
  const file = path.join(dir, `${SESSION}.url`);
  const before = fs.statSync(file).mtimeMs;
  files.write(SESSION, URL1);
  assert.equal(fs.statSync(file).mtimeMs, before, "unchanged: not rewritten");
  files.write(SESSION, URL2);
  assert.equal(readStatusLink(SESSION, dir), URL2);
  files.write("../evil", URL1);
  files.write(SESSION, "javascript:alert(1)");
  assert.equal(readStatusLink("../evil", dir), undefined);
  assert.equal(readStatusLink(SESSION, dir), URL2);
  assert.deepEqual(fs.readdirSync(dir), [`${SESSION}.url`]);
  assert.equal(readStatusLink(undefined, dir), undefined);
});

test("link files stay bounded", () => {
  const dir = tmp();
  const files = new StatusLinkFiles(dir, 3);
  for (let i = 0; i < 25; i++) files.write(`s${i}`, `${URL1}${i}`);
  assert.ok(fs.readdirSync(dir).length <= 3 + 20, "pruned every 20 writes");
});

test("segment: an OSC 8 link where the terminal has them, else the URL; nothing without a link", () => {
  const dir = tmp();
  new StatusLinkFiles(dir).write(SESSION, URL1);
  assert.equal(linkSegment(SESSION, ITERM, dir), `\x1b]8;;${URL1}\x1b\\🌿 tree\x1b]8;;\x1b\\`);
  assert.equal(linkSegment(SESSION, APPLE_TERMINAL, dir), URL1);
  assert.equal(linkSegment(SESSION, { ...APPLE_TERMINAL, CCC_STATUSLINE_LINK: "osc8" }, dir),
    `\x1b]8;;${URL1}\x1b\\🌿 tree\x1b]8;;\x1b\\`);
  assert.equal(linkSegment(SESSION, { ...ITERM, CCC_STATUSLINE_LINK: "url" }, dir), URL1);
  assert.equal(linkSegment("other", ITERM, dir), "");
});

/** Craig's kind of status line: a shell command reading Claude Code's JSON from stdin. */
const OWN_COMMAND = "input=$(cat); printf '494k (49%%) | %s' \"$(echo \"$input\" | grep -o model)\"";

function setup(statusLine) {
  const dir = tmp();
  const settings = path.join(dir, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ model: "opus", ...(statusLine ? { statusLine } : {}) }));
  const links = path.join(dir, "links");
  new StatusLinkFiles(links).write(SESSION, URL1);
  return { dir, paths: { settings, saved: path.join(dir, "statusline.json"), links } };
}

test("install wraps the existing command; the status line keeps it and adds the link", () => {
  const original = { type: "command", command: OWN_COMMAND, padding: 0 };
  const { dir, paths } = setup(original);
  const result = installStatusline(paths);
  assert.equal(result.ok, true);
  const settings = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
  assert.deepEqual(settings.statusLine, { type: "command", command: STATUSLINE_COMMAND, padding: 0 });
  assert.equal(settings.model, "opus", "other settings kept");
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith("settings.json.ccc-backup-")));
  const input = JSON.stringify({ session_id: SESSION, model: { display_name: "Opus" } });
  if (process.platform !== "win32") {
    assert.equal(renderStatusline(input, paths, APPLE_TERMINAL), `494k (49%) | model | ${URL1}`);
  }
  assert.equal(installStatusline(paths).ok, true, "again: harmless");
  assert.equal(JSON.parse(fs.readFileSync(paths.saved, "utf-8")).statusLine.command, OWN_COMMAND,
    "a second install never saves ccc's own command as the one to wrap");
  assert.equal(uninstallStatusline(paths).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.settings, "utf-8")).statusLine, original);
  assert.equal(fs.existsSync(paths.saved), false);
});

test("install with no status line: the link alone; uninstall removes it", () => {
  const { paths } = setup(undefined);
  assert.equal(installStatusline(paths).ok, true);
  assert.equal(renderStatusline(JSON.stringify({ session_id: SESSION }), paths, APPLE_TERMINAL), URL1);
  assert.equal(renderStatusline("not json", paths, APPLE_TERMINAL), "");
  uninstallStatusline(paths);
  assert.equal(JSON.parse(fs.readFileSync(paths.settings, "utf-8")).statusLine, undefined);
});

test("install leaves invalid settings and non-command status lines alone", () => {
  const { paths } = setup({ type: "static", text: "x" });
  assert.equal(installStatusline(paths).ok, false);
  const bad = setup(undefined);
  fs.writeFileSync(bad.paths.settings, "{ not json");
  assert.equal(installStatusline(bad.paths).ok, false);
  assert.equal(fs.readFileSync(bad.paths.settings, "utf-8"), "{ not json");
});

test("`ccc statusline` runs without the proxy and prints nothing for an unknown session", () => {
  const home = tmp();
  const result = spawnSync(process.execPath, [CLI, "statusline"], {
    input: JSON.stringify({ session_id: SESSION }), encoding: "utf-8",
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: home },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("newest-tree lookups run in the background long enough for the slow sessions query", async () => {
  // Staging's sessions lookup took 7-22 s (2026-11-12); 10 s dropped most of them.
  assert.ok(NEWEST_TREE_FETCH_TIMEOUT_MS >= 30_000);
  assert.ok(NEWEST_TREE_CURRENT_WAIT_MS <= 10_000, "an MCP call still waits at most 10 s");
  const seen = [];
  const lookup = new NewestTreeLookup(async (p) => {
    const q = new URL(p, "http://x").searchParams.get("q");
    return { status: 200, body: Buffer.from(JSON.stringify({ sessions: [{ session_id: q,
      latest_tree: { request_id: "r1", ref: "r1-v1", links: { url: URL2 } } }] })) };
  });
  lookup.onTree((id, tree) => seen.push([id, tree.url]));
  await lookup.settle(SESSION, 1_000);
  assert.deepEqual(seen, [[SESSION, URL2]]);
});
