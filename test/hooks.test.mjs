import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { execSync } from "node:child_process";
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

/** Claude Code hook output with OSC 8 hyperlinks removed, so expectations stay readable. */
const OSC8 = /\x1b\]8;;[^\x07]*\x07/g;
const unlink = (v) =>
  typeof v === "string" ? v.replace(OSC8, "")
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unlink(x)]))
  : v;
const claimed = (q, input) => unlink(q.claim(input));

test("trailer delivery is isolated by session, including identical link keys", () => {
  const queue = new NoticeDeliveryQueue(undefined, undefined, false);
  queue.setTrailer((id) => ({ key: "same-key", link: `https://x/${id}` }), "message");
  queue.claim(display({ final: true, session_id: "A" }));
  assert.match(queue.claim(stop({ session_id: "B" })).systemMessage, /https:\/\/x\/B/);
  assert.equal(queue.claim(stop({ session_id: "A" })), null);
  queue.setTrailer((id) => ({ key: "same-key", link: `https://x/${id}` }), "turn");
  assert.match(queue.claim(stop({ session_id: "C" })).systemMessage, /https:\/\/x\/C/);
});

test("turn Stop fallback includes the success link exactly once in both color modes", () => {
  for (const color of [true, false]) {
    const queue = new NoticeDeliveryQueue(undefined, undefined, color);
    const resolve = () => ({ key: "k", link: "https://x/page" });
    queue.setLink(resolve);
    queue.setTrailer(resolve, "turn");
    queue.queuePrefix("optimized");
    const output = claimed(queue, stop()).systemMessage;
    assert.equal(output.split("https://x/page").length - 1, 1);
    assert.match(output, /optimized[^\n]*\n  https:\/\/x\/page/);
  }
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
  const queue = new NoticeDeliveryQueue(undefined, undefined, true);
  queue.queueSuffix("⚠ MemTree degraded — this turn ran uncompressed");
  assert.equal(queue.claim(display({ final: false })), null);
  assert.deepEqual(queue.claim(display({ index: 1, final: true, delta: "done" })), {
    hookSpecificOutput: {
      hookEventName: "MessageDisplay",
      displayContent:
        "done\n\x1b[33m⚠ MemTree degraded — this turn ran uncompressed\x1b[39m",
    },
  });
  assert.equal(queue.claim(stop()), null);

  queue.queueSuffix("⚠ fallback");
  assert.deepEqual(queue.claim(stop()), {
    systemMessage: "\x1b[33m⚠ fallback\x1b[39m",
  });
  assert.equal(queue.claim(stop()), null);
});

test("a pending link rides the success line once per key, in display or Stop, never alone", () => {
  const queue = new NoticeDeliveryQueue(undefined, undefined, true);
  let link = { key: "index-a", link: "https://app.polychat.co/m/aaaaaaaaaaaa" };
  queue.setLink((sessionId) => (sessionId === "session-1" ? link : undefined));
  assert.equal(queue.linkPending("session-1"), true);
  assert.equal(queue.linkPending("session-2"), false);

  // No success line queued: the link never appears by itself.
  assert.equal(queue.claim(display({ final: true })), null);
  assert.equal(queue.claim(stop()), null);
  assert.equal(queue.linkPending("session-1"), true, "peeking does not mark it shown");

  // Green text incl. separator, then the bare link (no SGR glued to the URL).
  queue.queuePrefix("✓ MemTree · conversation optimized");
  assert.deepEqual(queue.claim(display()), {
    hookSpecificOutput: {
      hookEventName: "MessageDisplay",
      displayContent:
        "\x1b[32m✓ MemTree · conversation optimized\x1b[39m\n" +
        "  https://app.polychat.co/m/aaaaaaaaaaaa\n\nanswer",
    },
  });
  assert.equal(queue.linkPending("session-1"), false);
  // Every success line carries the current page below it, same index or not.
  link = { key: "index-a", link: "https://app.polychat.co/m/aaaaaaaaaaab" };
  queue.queuePrefix("✓ MemTree · conversation optimized");
  assert.deepEqual(queue.claim(stop()), {
    systemMessage:
      "\x1b[32m✓ MemTree · conversation optimized\x1b[39m\n" +
      "  https://app.polychat.co/m/aaaaaaaaaaab",
  });

  // A new index: Stop fallback carries its page on the success line, once.
  link = { key: "index-b", link: "https://app.polychat.co/m/bbbbbbbbbbbb" };
  queue.queuePrefix("✓ MemTree · conversation optimized");
  assert.deepEqual(queue.claim(stop()), {
    systemMessage:
      "\x1b[32m✓ MemTree · conversation optimized\x1b[39m\n" +
      "  https://app.polychat.co/m/bbbbbbbbbbbb",
  });
  assert.equal(queue.claim(stop()), null);

  // Another session's display, subagents, and a throwing resolver: plain line.
  link = { key: "index-c", link: "https://app.polychat.co/m/cccccccccccc" };
  queue.queuePrefix("✓ ok");
  assert.equal(
    queue.claim(display({ session_id: "session-2" })).hookSpecificOutput.displayContent,
    "\x1b[32m✓ ok\x1b[39m\nanswer"
  );
  assert.equal(queue.linkPending("session-1"), true, "unshown for its own session");
  queue.setLink(() => {
    throw new Error("boom");
  });
  queue.queuePrefix("✓ ok");
  assert.deepEqual(queue.claim(stop()), { systemMessage: "\x1b[32m✓ ok\x1b[39m" });
  queue.setLink(null);
  assert.equal(queue.linkPending("session-1"), false);
});

test("trailer follows every finished message, is green once per key, falls back to Stop", () => {
  const queue = new NoticeDeliveryQueue(undefined, undefined, true);
  let link = { key: "index-a", link: "https://app.polychat.co/m/aaaaaaaaaaaa" };
  queue.setTrailer((sessionId) => (sessionId === "session-1" ? link : undefined));

  // Mid-message flushes carry nothing; the finished message gets the trailer,
  // green "new index" the first time a key is seen, blank line above.
  assert.equal(queue.claim(display({ final: false })), null);
  assert.deepEqual(queue.claim(display({ final: true, delta: "done" })), {
    hookSpecificOutput: {
      hookEventName: "MessageDisplay",
      displayContent:
        "done\n\n\x1b[32m• MemTree\x1b[39m\n  https://app.polychat.co/m/aaaaaaaaaaaa",
    },
  });
  // Stop after a message carried it: nothing more this turn.
  assert.equal(queue.claim(stop()), null);

  // Same key on the next message: dim label, still shown.
  assert.equal(
    queue.claim(display({ final: true, delta: "again" })).hookSpecificOutput.displayContent,
    "again\n\n\x1b[2m• MemTree\x1b[22m\n  https://app.polychat.co/m/aaaaaaaaaaaa"
  );
  assert.equal(queue.claim(stop()), null);

  // A turn that renders no message: Stop carries the trailer, once.
  link = { key: "index-b", link: "https://app.polychat.co/m/bbbbbbbbbbbb" };
  assert.deepEqual(queue.claim(stop()), {
    systemMessage: "\x1b[32m• MemTree\x1b[39m\n  https://app.polychat.co/m/bbbbbbbbbbbb",
  });
  assert.deepEqual(queue.claim(stop()), {
    systemMessage: "\x1b[2m• MemTree\x1b[22m\n  https://app.polychat.co/m/bbbbbbbbbbbb",
  });

  // With a success line on the same (single-flush) message: line, answer, trailer.
  queue.queuePrefix("✓ ok");
  assert.equal(
    queue.claim(display({ final: true, delta: "answer" })).hookSpecificOutput.displayContent,
    "\x1b[32m✓ ok\x1b[39m\nanswer\n\n\x1b[2m• MemTree\x1b[22m\n  https://app.polychat.co/m/bbbbbbbbbbbb"
  );
  // Delta ending in a newline gets no extra separator before the blank line.
  assert.equal(
    queue.claim(display({ final: true, delta: "text\n" })).hookSpecificOutput.displayContent,
    "text\n\n\x1b[2m• MemTree\x1b[22m\n  https://app.polychat.co/m/bbbbbbbbbbbb"
  );

  // Other sessions, subagents, a throwing resolver, no resolver: nothing.
  assert.equal(queue.claim(display({ final: true, session_id: "session-2" })), null);
  assert.equal(queue.claim(display({ final: true, agent_id: "agent-1" })), null);
  queue.setTrailer(() => {
    throw new Error("boom");
  });
  assert.equal(queue.claim(display({ final: true })), null);
  queue.setTrailer(null);
  assert.equal(queue.claim(stop()), null);
});

test("trailer note follows the bare link, dim", () => {
  const queue = new NoticeDeliveryQueue(undefined, undefined, true);
  let link = { key: "k1", link: "https://x/m/1", note: "/memtree-compact to compact session" };
  queue.setTrailer(() => link, "message");
  assert.equal(
    queue.claim(display({ final: true, delta: "a" })).hookSpecificOutput.displayContent,
    "a\n\n\x1b[32m• MemTree\x1b[39m · \x1b[2m/memtree-compact to compact session\x1b[22m\n  https://x/m/1"
  );
  assert.equal(
    queue.claim(display({ final: true, delta: "b" })).hookSpecificOutput.displayContent,
    "b\n\n\x1b[2m• MemTree\x1b[22m · \x1b[2m/memtree-compact to compact session\x1b[22m\n  https://x/m/1"
  );
  link = { key: "k1", link: "https://x/m/2" };
  assert.equal(
    queue.claim(display({ final: true, delta: "c" })).hookSpecificOutput.displayContent,
    "c\n\n\x1b[2m• MemTree\x1b[22m\n  https://x/m/2",
    "no note once the turn compressed"
  );
});

test("trailer placement 'stop' shows it once per turn on Stop only", () => {
  const queue = new NoticeDeliveryQueue(undefined, undefined, false);
  queue.setTrailer(() => ({ key: "k", link: "https://x/m/1" }), "stop");
  assert.equal(queue.claim(display({ final: true })), null);
  assert.deepEqual(queue.claim(stop()), { systemMessage: "• MemTree\n  https://x/m/1" });
  assert.deepEqual(queue.claim(stop()), { systemMessage: "• MemTree\n  https://x/m/1" });
  queue.queueSuffix("⚠ warn");
  assert.deepEqual(queue.claim(stop()), { systemMessage: "⚠ warn\n• MemTree\n  https://x/m/1" });
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
  const queue = new NoticeDeliveryQueue(undefined, undefined, false);
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
  plain.queueSuffix("⚠ warning");
  assert.equal(
    plain.claim(display({ final: true })).hookSpecificOutput.displayContent,
    "answer\n⚠ warning"
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
    assert.equal(manifest.name, "ccc");
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
    assert.equal(
      config.hooks.SessionStart,
      undefined,
      "no banner requested, so no SessionStart hook is registered"
    );
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

test("session plugin lists /memtree-view and /memtree-compact in the command menu", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ccc-cmd-"));
  const plugin = createSessionNoticePlugin("http://127.0.0.1:1/_ccc/hooks/x", { tempRoot });
  try {
    const md = await fsp.readFile(path.join(plugin.dir, "commands", "memtree-view.md"), "utf-8");
    assert.match(md, /^---\ndescription: Show the link to this session's MemTree page\n---\n/);
    const help = await fsp.readFile(path.join(plugin.dir, "commands", "memtree.md"), "utf-8");
    assert.match(help, /description: List the MemTree commands/);
    const compact = await fsp.readFile(path.join(plugin.dir, "commands", "memtree-compact.md"), "utf-8");
    assert.match(compact, /argument-hint: \[tokens \| off\]/);
  } finally {
    plugin.close();
  }
});

test("startup banner rides a SessionStart command hook emitting systemMessage JSON", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ccc-hooks-test-"));
  // Leading newline and an apostrophe: the newline must survive as a JSON
  // escape (sh/zsh `echo` would expand it and corrupt the payload), and the
  // quote exercises shell quoting.
  const message = "\n·─╼ • MemTree · Infinite Context Enabled ∞ ╾─· it's on";
  const plugin = createSessionNoticePlugin(
    "http://127.0.0.1:12345/_ccc/hooks/unpredictable",
    { tempRoot, startupMessage: message }
  );
  try {
    const config = JSON.parse(
      await fsp.readFile(path.join(plugin.dir, "hooks", "hooks.json"), "utf-8")
    );
    const entry = config.hooks.SessionStart[0];
    assert.equal(
      entry.matcher,
      "startup|resume|clear",
      "compaction continues the same conversation and must not re-show it"
    );
    const hook = entry.hooks[0];
    assert.equal(
      hook.type,
      "command",
      "SessionStart accepts only command/mcp_tool hooks, never http"
    );
    // Every shell Claude Code might use must yield byte-identical valid JSON.
    for (const shell of ["/bin/sh", "/bin/bash", "/bin/zsh"]) {
      const stdout = execSync(hook.command, { shell, encoding: "utf-8" });
      assert.deepEqual(
        JSON.parse(stdout),
        { systemMessage: message },
        `${shell} must not mangle the escaped newline`
      );
    }
  } finally {
    const dir = plugin.dir;
    plugin.close();
    await assert.rejects(fsp.stat(dir), "banner file leaves nothing behind");
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
