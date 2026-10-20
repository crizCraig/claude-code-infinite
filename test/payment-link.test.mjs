import test from "node:test";
import assert from "node:assert/strict";
import {
  PAYMENT_LINK_PATH,
  PAYMENT_LINK_REFRESH_MARGIN_MS,
  PAYMENT_LINK_RETRY_MS,
  PaymentLinkCache,
  fetchPaymentLink,
  formatUsd,
  parsePaymentLink,
  paymentLinkFresh,
} from "../dist/payment-link.js";

const URL = "https://app.polychat.co/p/Ab3xY9qwertyuiop";
const BODY = {
  url: URL, plan: "Starter", monthly_price_usd: 5, reason: "free_credit_used",
  expires_at: "2026-10-20T13:00:00+00:00",
};

test("a server body becomes a link; anything off-shape is no link", () => {
  assert.deepEqual(parsePaymentLink(BODY), {
    url: URL, plan: "Starter", monthlyPriceUsd: 5, reason: "free_credit_used",
    expiresAt: Date.parse("2026-10-20T13:00:00Z"),
  });
  assert.equal(parsePaymentLink({ ...BODY, reason: "other", expires_at: "x" }).reason, null);
  assert.equal(parsePaymentLink({ ...BODY, expires_at: undefined }).expiresAt, null);
  for (const bad of [
    null, "x", {}, { ...BODY, url: "https://evil.example/pay" },
    { ...BODY, url: `${URL}\u001b]8;;x` }, { ...BODY, url: "javascript:alert(1)//p/Ab3xY9qwertyuiop" },
    { ...BODY, url: "https://app.polychat.co/p/short" }, { ...BODY, plan: "Starter\u001b[31m" },
    { ...BODY, plan: "" }, { ...BODY, monthly_price_usd: 0 }, { ...BODY, monthly_price_usd: "5" },
    { ...BODY, monthly_price_usd: Infinity },
    { ...BODY, url: "https://evil.example/p/Ab3xY9qwertyuiop" },
    { ...BODY, url: "http://app.polychat.co/p/Ab3xY9qwertyuiop" },
    { ...BODY, url: "https://polychat.co.evil.example/p/Ab3xY9qwertyuiop" },
    { ...BODY, url: "https://someone-else.run.app/p/Ab3xY9qwertyuiop" },
  ]) assert.equal(parsePaymentLink(bad), null, JSON.stringify(bad));
  assert.ok(parsePaymentLink({ ...BODY, url: "http://local.polychat.co:8000/p/Ab3xY9qwertyuiop" }));
  assert.ok(parsePaymentLink({ ...BODY,
    url: "https://polychat-staging-421312241218.us-west2.run.app/p/Ab3xY9qwertyuiop" }));
});

test("fetchPaymentLink: POST with the key; 404, errors and timeouts are null", async () => {
  const seen = [];
  const ok = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(BODY), { status: 200 });
  };
  const link = await fetchPaymentLink({ baseUrl: "https://api.x/", apiKey: "k", fetchImpl: ok,
    headers: { "x-client": "cc-infinite" } });
  assert.equal(link.url, URL);
  assert.equal(seen[0].url, `https://api.x${PAYMENT_LINK_PATH}`);
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers.authorization, "Bearer k");
  assert.equal(seen[0].init.headers["x-client"], "cc-infinite");
  const notFound = async () => new Response("{}", { status: 404 });
  assert.equal(await fetchPaymentLink({ baseUrl: "b", apiKey: "k", fetchImpl: notFound }), null);
  const down = async () => { throw new Error("ECONNREFUSED"); };
  assert.equal(await fetchPaymentLink({ baseUrl: "b", apiKey: "k", fetchImpl: down }), null);
  const html = async () => new Response("<html>", { status: 200 });
  assert.equal(await fetchPaymentLink({ baseUrl: "b", apiKey: "k", fetchImpl: html }), null);
});

test("cache: one fetch shared, reused while fresh, refetched near expiry", async () => {
  let now = 0;
  let fetches = 0;
  const cache = new PaymentLinkCache(async () => {
    fetches++;
    return { url: URL, plan: "Starter", monthlyPriceUsd: 5, reason: null, expiresAt: 3_600_000 };
  }, () => now);
  assert.equal(cache.current(), null);
  const [a, b] = await Promise.all([cache.get(), cache.get()]);
  assert.equal(a, b);
  assert.equal(fetches, 1);
  assert.equal(cache.current().url, URL);
  now = 3_600_000 - PAYMENT_LINK_REFRESH_MARGIN_MS + 1;
  assert.equal(cache.current(), null, "too close to expiry to show");
  await cache.get();
  assert.equal(fetches, 2);
});

test("cache: a fetch that throws counts as a failure, never a stuck promise", async () => {
  const cache = new PaymentLinkCache(async () => { throw new Error("boom"); });
  assert.equal(await cache.get(), null);
  assert.equal(await cache.get(), null);
});

test("cache: after a failure (old server) it waits before asking again", async () => {
  let now = 0;
  let fetches = 0;
  const cache = new PaymentLinkCache(async () => { fetches++; return null; }, () => now);
  assert.equal(await cache.get(), null);
  assert.equal(await cache.get(), null);
  assert.equal(fetches, 1);
  now = PAYMENT_LINK_RETRY_MS;
  await cache.get();
  assert.equal(fetches, 2);
});

test("settled waits for a fetch in flight, but no longer than asked", async () => {
  let release;
  const cache = new PaymentLinkCache(() => new Promise((resolve) => { release = resolve; }));
  await cache.settled(10); // nothing in flight: returns at once
  void cache.get();
  const started = Date.now();
  await cache.settled(30);
  assert.ok(Date.now() - started < 1000);
  assert.equal(cache.current(), null);
  release({ url: URL, plan: "Starter", monthlyPriceUsd: 5, reason: null, expiresAt: null });
  await cache.settled(1000);
  assert.equal(cache.current().url, URL);
});

test("freshness and prices", () => {
  const link = { url: URL, plan: "S", monthlyPriceUsd: 5, reason: null, expiresAt: null };
  assert.ok(paymentLinkFresh(link, 1e15), "no expiry: always fresh");
  assert.equal(formatUsd(5), "$5");
  assert.equal(formatUsd(7.5), "$7.50");
});
