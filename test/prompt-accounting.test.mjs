import test from "node:test";
import assert from "node:assert/strict";
import { PromptAccounting } from "../dist/prompt-accounting.js";

const user = (text) => ({ role: "user", content: text });

test("prompt accounting requires exact normalized text and a successful delivery", () => {
  const prompts = new PromptAccounting();
  prompts.add("s", "short", "pending owner");
  prompts.add("s", "long", "pending owner extended");
  prompts.capture("s", user("pending owner extended"))(false);
  assert.equal(prompts.pending("s"), 2);
  prompts.capture("s", user("pending owner extended"))(true);
  assert.equal(prompts.hasId("short"), true);
  assert.equal(prompts.hasId("long"), false);
  prompts.capture("s", user(" prefix pending owner"))(true);
  prompts.capture("s", user("pending owner suffix"))(true);
  assert.equal(prompts.pending("s"), 1);
  prompts.capture("s", user("pending\n owner <system-reminder>ambient</system-reminder>"))(true);
  assert.equal(prompts.pending("s"), 0);
});

test("duplicate prompt text retires one oldest record per delivery, including concurrent deliveries", () => {
  const prompts = new PromptAccounting();
  prompts.add("s", "a", "same prompt");
  prompts.add("s", "b", " same\n prompt ");
  const one = prompts.capture("s", user("same prompt"));
  const two = prompts.capture("s", user("same prompt"));
  one(true);
  assert.equal(prompts.hasId("a"), false);
  assert.equal(prompts.hasId("b"), true);
  one(true);
  assert.equal(prompts.hasId("b"), true, "settlement is idempotent");
  two(true);
  assert.equal(prompts.pending("s"), 0);
});

test("delivery snapshot excludes later hooks, other sessions and tool-result text", () => {
  const prompts = new PromptAccounting();
  prompts.add("s", "a", "hello");
  prompts.add("other", "b", "hello");
  const settle = prompts.capture("s", user("hello"));
  prompts.add("s", "new", "hello");
  settle(true);
  assert.equal(prompts.hasId("new"), true);
  assert.equal(prompts.hasId("b"), true);
  prompts.capture("s", { role: "user", content: [{ type: "tool_result", content: "hello" }] })(true);
  prompts.capture("s", user("<system-reminder>hello</system-reminder>"))(true);
  assert.equal(prompts.pending("s"), 1);
});

test("unresolved records expire after ten minutes and retain only 32 per session", () => {
  let now = 0;
  const prompts = new PromptAccounting(() => now);
  for (let i = 0; i < 40; i++) prompts.add("s", String(i), "unresolved");
  assert.equal(prompts.pending("s"), 32);
  assert.equal(prompts.hasId("7"), false);
  assert.equal(prompts.hasId("8"), true);
  now = 599_999;
  assert.equal(prompts.pending("s"), 32);
  now = 600_000;
  assert.equal(prompts.pending("s"), 0);
});

test("accounting has a process-wide bound across many sessions", () => {
  const prompts = new PromptAccounting();
  for (let i = 0; i < 4097; i++) prompts.add(String(i), String(i), "unresolved");
  assert.equal(prompts.hasId("0"), false);
  assert.equal(prompts.hasId("1"), true);
  assert.equal(prompts.hasId("4096"), true);
});
