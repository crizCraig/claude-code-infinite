import test from "node:test";
import assert from "node:assert/strict";
import { browserOpenCommand, mayOpenBrowser, browserOpener } from "../dist/open-url.js";

const URL = "https://api.polychat.co/m/ea18af90658b";

test("each OS opens the URL with its own opener, the URL one argument (no shell)", () => {
  assert.deepEqual(browserOpenCommand(URL, "darwin"), { command: "open", args: [URL] });
  assert.deepEqual(browserOpenCommand(URL, "linux"), { command: "xdg-open", args: [URL] });
  assert.deepEqual(browserOpenCommand(URL, "freebsd"), { command: "xdg-open", args: [URL] });
  // rundll32 hands the URL to the default browser without cmd.exe parsing it.
  assert.deepEqual(browserOpenCommand(URL, "win32"),
    { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", URL] });
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
