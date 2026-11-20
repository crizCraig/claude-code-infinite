import test from "node:test";
import assert from "node:assert/strict";
import { NoticeDeliveryQueue } from "../dist/hooks.js";
import {
  PAYMENT_CONTINUES_LINE,
  PAYMENT_NOTICE_INTERVAL_MS,
  PAYMENT_PAGE_LABEL,
  PAYMENT_PAUSED_HEADLINE,
  PaymentNoticeThrottle,
  paymentNoticeText,
  subscribeUrlFromDetail,
} from "../dist/payment-notice.js";

const CHECKOUT =
  "https://app.polychat.co/payment?user_id=u-1&user_email=a%40b.c&price_id=p_1";
const DETAIL =
  "Payment required for a@b.c on polychat.co for use of MemTree API\n\n" +
  `We recommend Starter plan for $5/month: ${CHECKOUT}.\n\nMemTree compresses.`;

test("subscribe link comes from the 402 detail, tagged source=ccc", () => {
  assert.equal(subscribeUrlFromDetail(DETAIL), `${CHECKOUT}&source=ccc`);
  assert.equal(subscribeUrlFromDetail("Payment required"), "https://polychat.co/pricing");
});

test("notice text: headline, bare link line, continues line, account, page link", () => {
  const text = paymentNoticeText(DETAIL, "https://memtree.dev/m/abc");
  assert.deepEqual(text.split("\n"), [
    PAYMENT_PAUSED_HEADLINE,
    `  ${CHECKOUT}&source=ccc`,
    PAYMENT_CONTINUES_LINE,
    "Payment required for a@b.c on polychat.co for use of MemTree API",
    PAYMENT_PAGE_LABEL,
    "  https://memtree.dev/m/abc",
  ]);
  assert.ok(!paymentNoticeText(DETAIL).includes(PAYMENT_PAGE_LABEL));
});

test("throttle: first time due, then quiet until the interval passes", () => {
  let now = 1_000;
  const throttle = new PaymentNoticeThrottle(undefined, () => now);
  assert.equal(throttle.due(), true);
  throttle.markShown();
  now += PAYMENT_NOTICE_INTERVAL_MS - 1;
  assert.equal(throttle.due(), false);
  now += 1;
  assert.equal(throttle.due(), true);
  assert.equal(PAYMENT_NOTICE_INTERVAL_MS, 30 * 60 * 1000);
});

test("warning styling leaves link lines bare in both colour modes", () => {
  const text = paymentNoticeText(DETAIL, "https://memtree.dev/m/abc");
  for (const color of [true, false]) {
    const queue = new NoticeDeliveryQueue(undefined, undefined, color);
    queue.queueSuffix(text);
    const out = queue.claim({
      hook_event_name: "MessageDisplay",
      session_id: "s",
      index: 0,
      final: true,
      delta: "answer",
    }).hookSpecificOutput.displayContent;
    const lines = out.split("\n");
    assert.equal(lines[0], "answer");
    assert.equal(lines[2], `  ${CHECKOUT}&source=ccc`);
    assert.equal(lines.at(-1), "  https://memtree.dev/m/abc");
    const headline = color ? `\x1b[33m${PAYMENT_PAUSED_HEADLINE}\x1b[39m` : PAYMENT_PAUSED_HEADLINE;
    assert.equal(lines[1], headline);
    assert.equal(out.includes("\x1b["), color);
    assert.equal(queue.warningText(text).includes("\x1b["), color);
  }
});
