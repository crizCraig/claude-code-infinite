import test from "node:test";
import assert from "node:assert/strict";
import {
  checkForUpdate,
  compareVersions,
  parseVersion,
  NPM_LATEST_URL,
  SKIP_UPDATE_CHECK_ENV,
} from "../dist/update-check.js";

function registry(body, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (typeof body === "function") return body();
        return body;
      },
    };
  };
  return { fetchImpl, calls };
}

test("parseVersion accepts npm-shaped versions and rejects everything else", () => {
  assert.deepEqual(parseVersion("1.0.12"), [1, 0, 12]);
  assert.deepEqual(parseVersion("v2.3.4"), [2, 3, 4]);
  assert.deepEqual(parseVersion("1.2.3-beta.1"), [1, 2, 3]);
  assert.deepEqual(parseVersion(" 1.2.3 "), [1, 2, 3]);
  for (const bad of ["latest", "1.2", "1.2.3.4", "", "<html>", "1.2.3[2J"]) {
    assert.equal(parseVersion(bad), null, JSON.stringify(bad));
  }
});

test("compareVersions is numeric per component, not lexical", () => {
  assert.ok(compareVersions([1, 0, 12], [1, 0, 9]) > 0, "12 > 9");
  assert.ok(compareVersions([1, 10, 0], [1, 9, 9]) > 0);
  assert.ok(compareVersions([2, 0, 0], [1, 99, 99]) > 0);
  assert.equal(compareVersions([1, 0, 12], [1, 0, 12]), 0);
  assert.ok(compareVersions([1, 0, 11], [1, 0, 12]) < 0);
});

test("a newer registry version is reported with both versions", async () => {
  const { fetchImpl, calls } = registry({ version: "1.0.13" });
  const result = await checkForUpdate({
    currentVersion: "1.0.12",
    fetchImpl,
    env: {},
  });
  assert.deepEqual(result, { latest: "1.0.13", current: "1.0.12" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, NPM_LATEST_URL);
  assert.equal(calls[0].init.headers.accept, "application/json");
  assert.ok(calls[0].init.signal instanceof AbortSignal, "fetch is bounded");
});

test("same or older registry version is not an update", async () => {
  for (const latest of ["1.0.12", "1.0.11", "0.9.99"]) {
    const { fetchImpl } = registry({ version: latest });
    assert.equal(
      await checkForUpdate({ currentVersion: "1.0.12", fetchImpl, env: {} }),
      null,
      latest
    );
  }
});

test(`${SKIP_UPDATE_CHECK_ENV}=1 skips the fetch entirely`, async () => {
  const { fetchImpl, calls } = registry({ version: "9.9.9" });
  const result = await checkForUpdate({
    currentVersion: "1.0.12",
    fetchImpl,
    env: { [SKIP_UPDATE_CHECK_ENV]: "1" },
  });
  assert.equal(result, null);
  assert.equal(calls.length, 0, "registry must not be contacted");
});

test("every failure mode resolves to null, never rejects", async () => {
  const cases = [
    ["non-2xx", registry({ version: "9.9.9" }, 503).fetchImpl],
    ["malformed version", registry({ version: "latest" }).fetchImpl],
    ["missing version", registry({}).fetchImpl],
    ["non-object body", registry("nope").fetchImpl],
    [
      "json throws",
      registry(() => {
        throw new SyntaxError("bad json");
      }).fetchImpl,
    ],
    [
      "network error",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
    [
      "timeout",
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason));
        }),
    ],
  ];
  for (const [name, fetchImpl] of cases) {
    const result = await checkForUpdate({
      currentVersion: "1.0.12",
      fetchImpl,
      env: {},
      timeoutMs: 20,
    });
    assert.equal(result, null, name);
  }
});

test("an unparseable current version disables the check", async () => {
  const { fetchImpl, calls } = registry({ version: "9.9.9" });
  assert.equal(
    await checkForUpdate({ currentVersion: "dev", fetchImpl, env: {} }),
    null
  );
  assert.equal(calls.length, 0);
});
