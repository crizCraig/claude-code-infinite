import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addBoardChannel,
  boardChannelMcpConfig,
  boardChannelScript,
  planBoardChannel,
  withBoardChannelArgs,
} from "../dist/board-channel.js";

function boardCheckout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-board-test-"));
  fs.writeFileSync(path.join(dir, "board_channel.py"), "# stub\n");
  return dir;
}

const interactive = { interactive: true, env: {} };

test("no --board: nothing added, nothing said", () => {
  assert.deepEqual(planBoardChannel({ on: false }, interactive), { register: false });
  const warned = [];
  const launch = addBoardChannel(["fix it"], { on: false }, interactive, (l) => warned.push(l));
  assert.deepEqual(launch, { args: ["fix it"], file: null });
  assert.deepEqual(warned, []);
});

test("--board=DIR finds board_channel.py in the checkout; a file path works too", () => {
  const dir = boardCheckout();
  const script = path.join(dir, "board_channel.py");
  assert.deepEqual(planBoardChannel({ on: true, path: dir }, interactive),
    { register: true, script });
  assert.equal(boardChannelScript(script), script);
  assert.equal(boardChannelScript(path.join(dir, "missing")), undefined);
  assert.equal(boardChannelScript(path.join(os.tmpdir())), undefined, "dir without the script");
});

test("bare --board takes the path from CCC_BOARD_CHANNEL, then the config", () => {
  const fromEnv = boardCheckout();
  const fromConfig = boardCheckout();
  const plan = planBoardChannel({ on: true },
    { interactive: true, env: { CCC_BOARD_CHANNEL: fromEnv }, configPath: fromConfig });
  assert.equal(plan.script, path.join(fromEnv, "board_channel.py"));
  const viaConfig = planBoardChannel({ on: true }, { ...interactive, configPath: fromConfig });
  assert.equal(viaConfig.script, path.join(fromConfig, "board_channel.py"));
  const none = planBoardChannel({ on: true }, interactive);
  assert.equal(none.register, false);
  assert.match(none.note, /needs the ccc-board path/);
});

test("print or non-TTY runs never get it (Claude Code loads channels only interactively)", () => {
  const plan = planBoardChannel({ on: true, path: boardCheckout() },
    { interactive: false, env: {} });
  assert.equal(plan.register, false);
  assert.match(plan.note, /interactive/);
});

test("the opt-in uses = forms first, so no variadic option swallows the prompt", () => {
  assert.deepEqual(withBoardChannelArgs(["-c", "fix it"], "/tmp/x/mcp.json"), [
    "--mcp-config=/tmp/x/mcp.json",
    "--dangerously-load-development-channels=server:board",
    "-c",
    "fix it",
  ]);
});

test("config runs board_channel.py under python3 and passes CCC_BOARD_DIR when set", () => {
  assert.deepEqual(boardChannelMcpConfig("/b/board_channel.py", {}), {
    mcpServers: { board: { type: "stdio", command: "python3",
      args: ["/b/board_channel.py", "--name", "board"] } },
  });
  const withDir = boardChannelMcpConfig("/b/board_channel.py", { CCC_BOARD_DIR: "/t/board" });
  assert.deepEqual(withDir.mcpServers.board.env, { CCC_BOARD_DIR: "/t/board" });
});

test("addBoardChannel writes a private config, prepends the args, and cleans up", () => {
  const dir = boardCheckout();
  const launch = addBoardChannel(["fix it"], { on: true, path: dir }, interactive, () => {});
  assert.ok(launch.file);
  const configPath = launch.args[0].slice("--mcp-config=".length);
  assert.equal(configPath, launch.file.path);
  const written = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  assert.deepEqual(written.mcpServers.board.args[0], path.join(dir, "board_channel.py"));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  }
  assert.equal(launch.args.at(-1), "fix it");
  launch.file.close();
  launch.file.close();
  assert.equal(fs.existsSync(configPath), false);
});

test("a requested board that cannot run is a note, never a failed launch", () => {
  const warned = [];
  const launch = addBoardChannel(["x"], { on: true, path: "/nonexistent/ccc-board" },
    interactive, (l) => warned.push(l));
  assert.deepEqual(launch, { args: ["x"], file: null });
  assert.match(warned[0], /no board_channel\.py/);
});
