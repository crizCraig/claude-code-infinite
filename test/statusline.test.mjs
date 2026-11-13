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
  STATUSLINE_COMMAND, WRAPPED_ENV, installStatusline, linkSegment, renderStatusline,
  statusLineWantsLink, statuslinePaths, uninstallStatusline,
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
  const original = { type: "command", command: OWN_COMMAND, padding: 0, refreshInterval: 5,
    hideVimModeIndicator: true };
  const { dir, paths } = setup(original);
  const result = installStatusline(paths, "darwin");
  assert.equal(result.ok, true);
  const settings = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
  assert.deepEqual(settings.statusLine, { type: "command", command: STATUSLINE_COMMAND, padding: 0,
    refreshInterval: 5, hideVimModeIndicator: true }, "its other options stay");
  assert.equal(settings.model, "opus", "other settings kept");
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith("settings.json.ccc-backup-")));
  const input = JSON.stringify({ session_id: SESSION, model: { display_name: "Opus" } });
  if (process.platform !== "win32") {
    assert.equal(renderStatusline(input, paths, APPLE_TERMINAL), `494k (49%) | model | ${URL1}`);
  }
  assert.equal(installStatusline(paths, "darwin").ok, true, "again: harmless");
  assert.equal(JSON.parse(fs.readFileSync(paths.saved, "utf-8")).statusLine.command, OWN_COMMAND,
    "a second install never saves ccc's own command as the one to wrap");
  assert.equal(uninstallStatusline(paths, "darwin").ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.settings, "utf-8")).statusLine, original);
  assert.equal(fs.existsSync(paths.saved), false);
});

test("install with no status line: the link alone; uninstall removes it", () => {
  const { paths } = setup(undefined);
  assert.equal(installStatusline(paths, "darwin").ok, true);
  assert.equal(renderStatusline(JSON.stringify({ session_id: SESSION }), paths, APPLE_TERMINAL), URL1);
  assert.equal(renderStatusline("not json", paths, APPLE_TERMINAL), "");
  uninstallStatusline(paths, "darwin");
  assert.equal(JSON.parse(fs.readFileSync(paths.settings, "utf-8")).statusLine, undefined);
});

test("install leaves invalid settings and non-command status lines alone", () => {
  const { paths } = setup({ type: "static", text: "x" });
  assert.equal(installStatusline(paths, "darwin").ok, false);
  const bad = setup(undefined);
  fs.writeFileSync(bad.paths.settings, "{ not json");
  assert.equal(installStatusline(bad.paths, "darwin").ok, false);
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

test("a wrapped command that itself runs ccc's status line prints nothing inside, never recurses", () => {
  const { paths } = setup({ type: "command", command: "/opt/homebrew/bin/ccc statusline" });
  const result = installStatusline(paths, "darwin");
  assert.equal(result.ok, false, "a command that already runs ccc's is never wrapped");
  assert.match(result.message, /already runs ccc statusline/);
  const input = JSON.stringify({ session_id: SESSION });
  assert.equal(renderStatusline(input, paths, { ...APPLE_TERMINAL, [WRAPPED_ENV]: "1" }), "");
  for (const command of ["npx claude-code-infinite statusline", "bash -c 'ccc statusline'",
    "ccc.cmd statusline"]) {
    const other = setup({ type: "command", command });
    installStatusline(other.paths, "darwin");
    assert.equal(fs.existsSync(other.paths.saved), false, `${command} is never wrapped`);
  }
});

test("install keeps a symlinked settings file a symlink, and its mode", { skip: process.platform === "win32" }, () => {
  const { dir, paths } = setup({ type: "command", command: OWN_COMMAND });
  const real = path.join(dir, "dotfiles-settings.json");
  fs.renameSync(paths.settings, real);
  fs.chmodSync(real, 0o600);
  fs.symlinkSync(real, paths.settings);
  installStatusline(paths, "darwin");
  assert.equal(fs.lstatSync(paths.settings).isSymbolicLink(), true);
  assert.equal(fs.statSync(real).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(real, "utf-8")).statusLine.command, STATUSLINE_COMMAND);
  uninstallStatusline(paths, "darwin");
  assert.equal(fs.lstatSync(paths.settings).isSymbolicLink(), true);
  assert.equal(fs.statSync(real).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(real, "utf-8")).statusLine.command, OWN_COMMAND);
});

test("install is refused on Windows (Claude Code runs status lines in Git Bash there)", () => {
  const { paths } = setup({ type: "command", command: OWN_COMMAND });
  assert.equal(installStatusline(paths, "win32").ok, false);
  assert.equal(JSON.parse(fs.readFileSync(paths.settings, "utf-8")).statusLine.command, OWN_COMMAND);
});

test("each Claude config dir saves its own original", () => {
  const a = statuslinePaths({ CLAUDE_CONFIG_DIR: "/tmp/a" });
  const b = statuslinePaths({ CLAUDE_CONFIG_DIR: "/tmp/b" });
  assert.notEqual(a.saved, b.saved);
  assert.notEqual(a.saved, statuslinePaths({}).saved);
});

test("the proxy refreshes per request only for a status line that shows the link", () => {
  const check = (command) => {
    const { paths } = setup(command ? { type: "command", command } : undefined);
    return statusLineWantsLink(paths.settings);
  };
  assert.equal(check("ccc statusline"), true);
  assert.equal(check(`${OWN_COMMAND}; cat ~/.claude-code-infinite/statusline/x.url`), true);
  assert.equal(check(OWN_COMMAND), false);
  assert.equal(check(undefined), false);
});

test("a link file another process pruned is written again on the next refresh", () => {
  const dir = tmp();
  const files = new StatusLinkFiles(dir);
  files.write(SESSION, URL1);
  fs.unlinkSync(path.join(dir, `${SESSION}.url`));
  files.write(SESSION, URL1);
  assert.equal(readStatusLink(SESSION, dir), URL1);
});

test("uninstall only touches what install wrote, and needs its saved original", () => {
  const custom = { type: "command", command: "printf custom; ccc statusline" };
  const { paths } = setup(custom);
  assert.equal(installStatusline(paths, "darwin").ok, false);
  assert.equal(uninstallStatusline(paths).ok, true, "not installed: nothing changed");
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.settings, "utf-8")).statusLine, custom);
  const lost = setup({ type: "command", command: STATUSLINE_COMMAND });
  const result = uninstallStatusline(lost.paths);
  assert.equal(result.ok, false, "no saved original: no guess");
  assert.equal(JSON.parse(fs.readFileSync(lost.paths.settings, "utf-8")).statusLine.command,
    STATUSLINE_COMMAND);
});

test("the saved original follows the settings file, however its directory is spelled",
  { skip: process.platform === "win32" }, () => {
  const home = os.homedir();
  assert.equal(statuslinePaths({ CLAUDE_CONFIG_DIR: path.join(home, ".claude") }).saved,
    statuslinePaths({}).saved);
  const dir = tmp();
  const alias = path.join(tmp(), "alias");
  fs.symlinkSync(dir, alias);
  assert.equal(statuslinePaths({ CLAUDE_CONFIG_DIR: alias }).saved,
    statuslinePaths({ CLAUDE_CONFIG_DIR: dir }).saved);
});

test("a newer link is written again after another process wrote an older one", () => {
  const dir = tmp();
  const a = new StatusLinkFiles(dir);
  const b = new StatusLinkFiles(dir);
  b.write(SESSION, URL2);
  a.write(SESSION, URL1);
  b.write(SESSION, URL2);
  assert.equal(readStatusLink(SESSION, dir), URL2);
});
