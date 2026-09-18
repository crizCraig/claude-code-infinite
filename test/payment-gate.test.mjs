import test from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_SUBSCRIBE_URL,
  PAYMENT_GATE_HEADLINE,
  extractPaymentUrl,
  formatPaymentNotice,
  parsePaymentChoice,
  parsePaymentStatus,
} from "../dist/payment-gate.js";

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
  assert.equal(status.url, URL);
});

test("server payment_url wins over the message link", () => {
  const status = parsePaymentStatus({
    paid: false,
    payment_message: MESSAGE,
    payment_url: "https://app.polychat.co/payment?user_id=x",
  });
  assert.equal(status.url, "https://app.polychat.co/payment?user_id=x");
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

test("notice keeps newlines and the full url, strips markdown headings", () => {
  const text = formatPaymentNotice(parsePaymentStatus({ paid: false, payment_message: MESSAGE }));
  assert.ok(text.startsWith(PAYMENT_GATE_HEADLINE));
  assert.ok(text.includes(`Subscribe: ${URL}`));
  assert.ok(!text.includes("#"), text);
  assert.ok(text.includes("Subscription Plans\nYour usage exceeds"));
});

test("notice scrubs control characters but keeps newlines", () => {
  const text = formatPaymentNotice({
    paid: false,
    message: "line one[31m\nline two\ttabbed",
    url: null,
  });
  assert.ok(text.includes("line one [31m\nline two tabbed"), text);
});

test("notice without a message or url still points at pricing", () => {
  const text = formatPaymentNotice({ paid: false, message: null, url: null });
  assert.equal(text, `${PAYMENT_GATE_HEADLINE}\n\nSubscribe: ${FALLBACK_SUBSCRIBE_URL}`);
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
