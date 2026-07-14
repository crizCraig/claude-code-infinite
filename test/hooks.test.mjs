import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  NoticeDeliveryQueue,
  createSessionNoticePlugin,
  parseNoticeHookInput,
  supportsMessageDisplay,
  terminalSupportsColor,
  withSessionNoticePluginArgs,
} from "../dist/hooks.js";

const display = (overrides = {}) => ({
  hook_event_name: "MessageDisplay",
  session_id: "session-1",
  turn_id: "turn-1",
  message_id: "message-1",
  index: 0,
  final: false,
  delta: "answer",
  ...overrides,
});

const stop = (overrides = {}) => ({
  hook_event_name: "Stop",
  session_id: "session-1",
  stop_hook_active: false,
  ...overrides,
});

test("MessageDisplay prefixes success once without changing stored content", () => {
  const queue = new NoticeDeliveryQueue(undefined, undefined, true);
  queue.queuePrefix("✓ MemTree · conversation optimized");
  assert.deepEqual(queue.claim(display()), {
    hookSpecificOutput: {
      hookEventName: "MessageDisplay",
      displayContent:
        "\x1b[32m✓ MemTree · conversation optimized\x1b[39m\nanswer",
    },
  });
  assert.equal(queue.claim(display()), null);
  assert.equal(queue.claim(stop()), null);
});

test("MessageDisplay resolves late success metrics when the notice is claimed", () => {
  let latencyMs = 12;
  const queue = new NoticeDeliveryQueue(undefined, undefined, true);
  queue.queuePrefix(() => `✓ MemTree · conversation optimized in ${latencyMs}ms`);
  latencyMs = 34;
  assert.equal(
    queue.claim(display()).hookSpecificOutput.displayContent,
    "\x1b[32m✓ MemTree · conversation optimized in 34ms\x1b[39m\nanswer"
  );
});

test("MessageDisplay appends warnings only on final; Stop is no-duplicate fallback", () => {
  const queue = new NoticeDeliveryQueue();
  queue.queueSuffix("⚠ MemTree degraded — this turn ran uncompressed");
  assert.equal(queue.claim(display({ final: false })), null);
  assert.deepEqual(queue.claim(display({ index: 1, final: true, delta: "done" })), {
    hookSpecificOutput: {
      hookEventName: "MessageDisplay",
      displayContent: "done\n⚠ MemTree degraded — this turn ran uncompressed",
    },
  });
  assert.equal(queue.claim(stop()), null);

  queue.queueSuffix("⚠ fallback");
  assert.deepEqual(queue.claim(stop()), { systemMessage: "⚠ fallback" });
  assert.equal(queue.claim(stop()), null);
});

test("subagent hooks cannot claim and expired notices are dropped", () => {
  let now = 100;
  const queue = new NoticeDeliveryQueue(10, () => now, true);
  queue.queuePrefix("main");
  assert.equal(queue.claim(display({ agent_id: "agent-1" })), null);
  assert.ok(queue.claim(display()), "main hook still claims after ignored agent hook");

  queue.queuePrefix("old");
  now = 111;
  assert.equal(queue.claim(display()), null);
});

test("prompt_id prevents an unrelated display or Stop from claiming", () => {
  const queue = new NoticeDeliveryQueue(undefined, undefined, true);
  queue.queuePrefix("main", undefined, "prompt-main");
  assert.equal(queue.claim(display({ prompt_id: "prompt-other" })), null);
  assert.equal(queue.claim(stop({ prompt_id: "prompt-other" })), null);
  assert.ok(queue.claim(display({ prompt_id: "prompt-main" })));

  // Older Claude versions omit prompt_id; keep the safe compatibility path.
  queue.queuePrefix("legacy", undefined, "prompt-main");
  assert.ok(queue.claim(display()));
});

test("payment callback runs only when a hook claims the notice", () => {
  let delivered = 0;
  const queue = new NoticeDeliveryQueue();
  queue.queueSuffix("payment", () => delivered++);
  queue.clearForUserRequest();
  assert.equal(delivered, 0);
  queue.queueSuffix("payment", () => delivered++);
  assert.deepEqual(queue.claim(stop()), { systemMessage: "payment" });
  assert.equal(delivered, 1);
});

test("success color follows terminal capability and monochrome conventions", () => {
  assert.equal(
    terminalSupportsColor({ NO_COLOR: "" }, { hasColors: () => true }),
    false
  );
  assert.equal(
    terminalSupportsColor({ TERM: "dumb" }, { hasColors: () => true }),
    false
  );
  assert.equal(
    terminalSupportsColor({ TERM: "xterm-256color" }, { hasColors: () => false }),
    false
  );
  assert.equal(
    terminalSupportsColor({ TERM: "xterm-256color" }, {
      hasColors: (count) => count === 8,
    }),
    true
  );

  const plain = new NoticeDeliveryQueue(undefined, undefined, false);
  plain.queuePrefix("✓ success");
  assert.equal(
    plain.claim(display()).hookSpecificOutput.displayContent,
    "✓ success\nanswer"
  );

  const greenFallback = new NoticeDeliveryQueue(undefined, undefined, true);
  greenFallback.queuePrefix("✓ success");
  assert.deepEqual(greenFallback.claim(stop()), {
    systemMessage: "\x1b[32m✓ success\x1b[39m",
  });
});

test("hook input validation rejects malformed fields", () => {
  assert.deepEqual(parseNoticeHookInput(display()), display());
  assert.deepEqual(parseNoticeHookInput(stop()), stop());
  assert.equal(parseNoticeHookInput(display({ index: -1 })), null);
  assert.equal(parseNoticeHookInput(display({ delta: 42 })), null);
  assert.equal(parseNoticeHookInput({ hook_event_name: "Stop" }), null);
  assert.equal(parseNoticeHookInput({ ...stop(), hook_event_name: "PreToolUse" }), null);
});

test("version gate is conservative around MessageDisplay introduction", () => {
  assert.equal(supportsMessageDisplay("2.1.165 (Claude Code)"), false);
  assert.equal(supportsMessageDisplay("2.1.166 (Claude Code)"), true);
  assert.equal(supportsMessageDisplay("Claude Code 2.2.0"), true);
  assert.equal(supportsMessageDisplay("unknown"), false);
});

test("session plugin contains HTTP hooks and argv prepending preserves user options", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ccc-hooks-test-"));
  const plugin = createSessionNoticePlugin(
    "http://127.0.0.1:12345/_ccc/hooks/unpredictable",
    { tempRoot }
  );
  try {
    const manifest = JSON.parse(
      await fsp.readFile(path.join(plugin.dir, ".claude-plugin", "plugin.json"), "utf-8")
    );
    const config = JSON.parse(
      await fsp.readFile(path.join(plugin.dir, "hooks", "hooks.json"), "utf-8")
    );
    assert.equal(manifest.name, "ccc-session-notices");
    for (const event of [
      "MessageDisplay",
      "Stop",
      "UserPromptSubmit",
      "SubagentStart",
      "SubagentStop",
    ]) {
      const hook = config.hooks[event][0].hooks[0];
      assert.equal(hook.type, "http");
      assert.equal(hook.url, "http://127.0.0.1:12345/_ccc/hooks/unpredictable");
    }
    assert.deepEqual(
      withSessionNoticePluginArgs(
        ["--plugin-dir", "/user/plugin", "--", "-literal prompt"],
        plugin.dir
      ),
      [
        "--plugin-dir",
        plugin.dir,
        "--plugin-dir",
        "/user/plugin",
        "--",
        "-literal prompt",
      ]
    );
  } finally {
    const dir = plugin.dir;
    plugin.close();
    plugin.close();
    await assert.rejects(fsp.stat(dir));
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test("Stop-only compatibility plugin keeps arming/lifecycle hooks", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ccc-hooks-test-"));
  const plugin = createSessionNoticePlugin(
    "http://127.0.0.1:12345/_ccc/hooks/unpredictable",
    { messageDisplay: false, tempRoot }
  );
  try {
    const config = JSON.parse(
      await fsp.readFile(path.join(plugin.dir, "hooks", "hooks.json"), "utf-8")
    );
    assert.ok(config.hooks.Stop);
    assert.deepEqual(Object.keys(config.hooks), [
      "Stop",
      "UserPromptSubmit",
      "SubagentStart",
      "SubagentStop",
    ]);
    assert.equal(config.hooks.MessageDisplay, undefined);
  } finally {
    plugin.close();
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});
