import test from "node:test";
import assert from "node:assert/strict";
import {
  browserOpenCommand, mayOpenBrowser, browserOpener, memtreePageUrl, urlOpenerFor,
} from "../dist/open-url.js";

const URL = "https://api.polychat.co/m/ea18af90658b";

test("each OS opens the URL with its own opener, the URL one argument (no shell)", () => {
  assert.deepEqual(browserOpenCommand(URL, "darwin"), { command: "open", args: [URL] });
  assert.deepEqual(browserOpenCommand(URL, "linux"), { command: "xdg-open", args: [URL] });
  assert.deepEqual(browserOpenCommand(URL, "freebsd"), { command: "xdg-open", args: [URL] });
  // rundll32 hands the URL to the default browser without cmd.exe parsing it,
  // System32's copy rather than one found on PATH.
  assert.deepEqual(browserOpenCommand(URL, "win32", { SystemRoot: "D:\\Win" }),
    { command: "D:\\Win\\System32\\rundll32.exe", args: ["url.dll,FileProtocolHandler", URL] });
  assert.equal(browserOpenCommand(URL, "win32", {}).command, "C:\\Windows\\System32\\rundll32.exe");
});

test("only http(s) URLs are opened", () => {
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "-n https://x", "", "ftp://x/y"]) {
    assert.equal(browserOpenCommand(bad, "darwin"), undefined, bad);
  }
  assert.ok(browserOpenCommand("http://localhost:8080/m/abc", "linux"));
});

test("a browser is opened only in an interactive local session", () => {
  const desktop = { interactive: true, env: {}, platform: "darwin" };
  assert.equal(mayOpenBrowser(desktop), true);
  assert.equal(mayOpenBrowser({ ...desktop, platform: "win32" }), true);
  assert.equal(mayOpenBrowser({ ...desktop, interactive: false }), false, "-p / non-TTY");
  for (const env of [{ CI: "true" }, { GITHUB_ACTIONS: "true" }]) {
    assert.equal(mayOpenBrowser({ ...desktop, env }), false, JSON.stringify(env));
  }
  assert.equal(mayOpenBrowser({ ...desktop, env: { CI: "0" } }), true, "CI=0 is not CI");
  for (const name of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) {
    assert.equal(mayOpenBrowser({ ...desktop, env: { [name]: "x" } }), false, name);
  }
  // Linux opens only with a display to open it on.
  const linux = { ...desktop, platform: "linux" };
  assert.equal(mayOpenBrowser(linux), false, "no display");
  assert.equal(mayOpenBrowser({ ...linux, env: { DISPLAY: ":0" } }), true);
  assert.equal(mayOpenBrowser({ ...linux, env: { WAYLAND_DISPLAY: "wayland-0" } }), true);
});

test("browserOpener runs the OS opener detached and never throws", () => {
  const calls = [];
  const open = browserOpener("darwin", (command, args, options) => {
    calls.push({ command, args, options });
    return { on() {}, unref() {} };
  });
  open(URL);
  open("file:///etc/passwd");
  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })),
    [{ command: "open", args: [URL] }]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");
  const failing = browserOpener("linux", () => { throw new Error("ENOENT"); });
  assert.doesNotThrow(() => failing(URL));
});

test("only a MemTree page of the environment ccc talks to is opened", () => {
  const prod = "https://api.polychat.co";
  for (const url of [
    "https://app.polychat.co/m/ea18af90658b",
    "https://api.polychat.co/m/ea18af90658b-s",
    "https://app.polychat.co/usage/memtree/229f05e7-d2e5-4494-a631-25dd42d5759e-v3-own",
  ]) assert.equal(memtreePageUrl(url, prod), true, url);
  for (const url of [
    "https://attacker.invalid/m/ea18af90658b",
    "https://app.polychat.co@attacker.invalid/m/ea18af90658b",
    "https://user:pw@app.polychat.co/m/ea18af90658b",
    "https://app.polychat.co.attacker.invalid/m/ea18af90658b",
    "https://app.polychat.co/usage",
    "https://app.polychat.co/api/keys/delete",
    "https://app.polychat.co/m/ea18af90658b?next=https://attacker.invalid",
    "https://app.polychat.co/m/ea18af90658b/../../logout",
    "http://app.polychat.co/m/ea18af90658b",
    "file:///m/ea18af90658b",
    "not a url",
  ]) assert.equal(memtreePageUrl(url, prod), false, url);
  const local = "http://localhost:8080";
  assert.equal(memtreePageUrl("http://localhost:8080/m/abcdef12", local), true);
  assert.equal(memtreePageUrl("http://localhost:8765/action", local), false, "another local port");
  assert.equal(memtreePageUrl("http://localhost:8080/action", local), false, "not a page");
});

test("urlOpenerFor: nothing where a browser can't appear; elsewhere only MemTree pages", () => {
  const base = { env: {}, platform: "darwin", memtreeBaseUrl: "https://api.polychat.co" };
  assert.equal(urlOpenerFor({ ...base, interactive: false }), undefined);
  assert.equal(urlOpenerFor({ ...base, interactive: true, env: { SSH_TTY: "/dev/ttys1" } }), undefined);
  const spawned = [];
  const open = urlOpenerFor({ ...base, interactive: true,
    spawnFn: (command, args) => { spawned.push(args.at(-1)); return { on() {}, unref() {} }; } });
  open("https://attacker.invalid/collect");
  open("https://app.polychat.co/m/ea18af90658b");
  assert.deepEqual(spawned, ["https://app.polychat.co/m/ea18af90658b"]);
});
