import test from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_SUBSCRIBE_URL,
  PAUSED_HEADLINE,
  PAUSED_FREE_CREDIT_HEADLINE,
  PAUSED_LOSS_LINES,
  PRINT_PAUSED_LINE,
  extractPaymentUrl,
  extractRecommendedPlan,
  formatPaymentNotice,
  hyperlink,
  parsePaymentChoice,
  parsePaymentStatus,
  paymentGatePrompt,
  withCheckoutSource,
  withShortPaymentUrl,
} from "../dist/payment-gate.js";

const SHORT = "https://app.polychat.co/p/Ab3xY9qwertyuiop";
const LINK = { url: SHORT, plan: "Starter", monthlyPriceUsd: 5, reason: "free_credit_used",
  expiresAt: null };

const URL =
  "https://app.polychat.co/payment?user_id=1d57c2b7-47ce-428e-990e-6ebba9d47f43&user_email=a%40b.c&price_id=price_1";
const MESSAGE =
  "# Subscription Plans\nYour usage exceeds our limits for Free. Based on your activity levels, we recommend 🌱 Starter plan for $5/month.\n\n## 🌱 Starter Plan\nYou can select a new plan at https://polychat.co/pricing\n\nOr subscribe to Starter at:\n" +
  URL +
  "\n";

test("paid body parses to paid with no message or url", () => {
  assert.deepEqual(parsePaymentStatus({ email: "a@b.c", paid: true, payment_message: null }), {
    paid: true,
    message: null,
    url: null,
  });
});

test("unpaid body without payment_url falls back to the link inside the message", () => {
  const status = parsePaymentStatus({ paid: false, payment_message: MESSAGE });
  assert.equal(status.paid, false);
  assert.equal(status.message, MESSAGE);
  assert.equal(status.url, `${URL}&source=ccc`);
});

test("withCheckoutSource appends source=ccc once, with ? or &", () => {
  assert.equal(withCheckoutSource("https://x/payment?a=1"), "https://x/payment?a=1&source=ccc");
  assert.equal(withCheckoutSource("https://x/payment"), "https://x/payment?source=ccc");
  assert.equal(withCheckoutSource("https://x/payment?source=ccc"), "https://x/payment?source=ccc");
});

test("server payment_url wins over the message link", () => {
  const status = parsePaymentStatus({
    paid: false,
    payment_message: MESSAGE,
    payment_url: "https://app.polychat.co/payment?user_id=x",
  });
  assert.equal(status.url, "https://app.polychat.co/payment?user_id=x&source=ccc");
});

test("a status link that isn't a plain http(s) URL is dropped (it is printed and opened)", () => {
  for (const bad of ['https://x/payment?a="$(rm -rf ~)"', "https://x/payment?a=`id`",
    "https://x/payment?a=\u001b]8;;", "file:///etc/passwd"]) {
    assert.equal(parsePaymentStatus({ paid: false, payment_url: bad }).url, null, bad);
  }
});

test("bodies without a boolean paid are unknown (null)", () => {
  assert.equal(parsePaymentStatus(null), null);
  assert.equal(parsePaymentStatus("nope"), null);
  assert.equal(parsePaymentStatus({ detail: "not found" }), null);
  assert.equal(parsePaymentStatus({ paid: "false" }), null);
});

test("extractPaymentUrl only matches /payment? links", () => {
  assert.equal(extractPaymentUrl("see https://polychat.co/pricing"), null);
  assert.equal(extractPaymentUrl(null), null);
  assert.equal(extractPaymentUrl(`x ${URL} y`), URL);
});

test("the gate with a short link: five lines in all, the server's plan and price", () => {
  const status = parsePaymentStatus({ paid: false, payment_message: MESSAGE });
  const text = formatPaymentNotice(status, { link: LINK });
  const prompt = paymentGatePrompt(LINK);
  assert.deepEqual([...text.split("\n"), prompt], [
    "MemTree is paused: your free credit is used up.",
    "Without it, long sessions hit the context limit and get compacted, losing",
    "information, and your sessions aren't saved or searchable.",
    `Starter is $5/month: ${SHORT}`,
    "[Enter] subscribe ($5/mo)   [c] continue without MemTree   [q] quit: ",
  ]);
  assert.ok(!text.includes("Subscription Plans"));
  assert.ok([...text.split("\n"), prompt].every((line) => line.length <= 78), "fits 80 columns");
});

test("interactive gate: the url is its own OSC 8 link, the headline bold yellow", () => {
  const text = formatPaymentNotice({ paid: false, message: null, url: URL },
    { hyperlinks: true, color: true, link: LINK });
  assert.ok(text.startsWith(`\x1b[1;33m${PAUSED_FREE_CREDIT_HEADLINE}\x1b[0m\n`), text);
  assert.ok(text.endsWith(`Starter is $5/month: ${hyperlink(SHORT, SHORT)}`), text);
});

test("an upgrade (plan limit) and an odd price read right", () => {
  const upgrade = { ...LINK, plan: "Basic", monthlyPriceUsd: 7.5, reason: "plan_limit" };
  assert.equal(paymentGatePrompt(upgrade),
    "[Enter] upgrade ($7.50/mo)   [c] continue without MemTree   [q] quit: ");
  assert.match(formatPaymentNotice({ paid: false, message: null, url: null }, { link: upgrade }),
    /^MemTree is paused: your plan's usage limit is reached\.\n[\s\S]*Basic is \$7\.50\/month: /);
});

test("old server (no short link): today's link, the plan from the prose, no price in the prompt", () => {
  const text = formatPaymentNotice(parsePaymentStatus({ paid: false, payment_message: MESSAGE }));
  assert.deepEqual(text.split("\n"), [
    PAUSED_HEADLINE, ...PAUSED_LOSS_LINES.split("\n"),
    `Starter plan, $5/month: ${URL}&source=ccc`,
  ]);
  assert.equal(paymentGatePrompt(null),
    "[Enter] subscribe   [c] continue without MemTree   [q] quit: ");
  const bare = formatPaymentNotice({ paid: false, message: "Please pay.", url: URL });
  assert.ok(bare.endsWith(`\nSubscribe: ${URL}`), bare);
});

test("print runs get one stderr line", () => {
  assert.ok(!PRINT_PAUSED_LINE.includes("\n"));
  assert.match(PRINT_PAUSED_LINE, /plain Claude Code/);
});

test("a 402 detail's long link is swapped for the short one, which is never re-tagged", () => {
  const detail = `Payment required for a@b.c\n\nSubscribe at:\n${URL}\n\nMemTree…`;
  const swapped = withShortPaymentUrl(detail, SHORT);
  assert.ok(swapped.includes(`\n${SHORT}\n`) && !swapped.includes("/payment?"), swapped);
  assert.equal(withShortPaymentUrl(detail, null), detail);
  assert.equal(withShortPaymentUrl("Payment required", SHORT), "Payment required");
  assert.equal(extractPaymentUrl(swapped), SHORT);
  assert.equal(extractPaymentUrl(`${URL} and ${SHORT}.`), SHORT);
  assert.equal(withCheckoutSource(SHORT), SHORT);
  assert.equal(extractPaymentUrl("https://x.co/p/short"), null);
});

test("extractRecommendedPlan scrubs control characters and tolerates no emoji", () => {
  assert.equal(
    extractRecommendedPlan("we recommend Pro plan for $20/month\u001b[0m"),
    "Pro plan, $20/month"
  );
  assert.equal(extractRecommendedPlan("no plan here"), null);
  assert.equal(extractRecommendedPlan(null), null);
});

test("notice without a message or url still points at pricing", () => {
  const text = formatPaymentNotice({ paid: false, message: null, url: null });
  assert.ok(text.endsWith(`\nSubscribe: ${FALLBACK_SUBSCRIBE_URL}`), text);
});

test("Enter subscribes, c continues, q quits, anything else continues", () => {
  assert.equal(parsePaymentChoice(""), "subscribe");
  assert.equal(parsePaymentChoice("  "), "subscribe");
  assert.equal(parsePaymentChoice("S"), "subscribe");
  assert.equal(parsePaymentChoice("c"), "continue");
  assert.equal(parsePaymentChoice("Q"), "quit");
  assert.equal(parsePaymentChoice("quit"), "quit");
  assert.equal(parsePaymentChoice("zzz"), "continue");
});
