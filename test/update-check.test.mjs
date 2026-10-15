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
          // Real fetch holds an I/O handle while pending. Keep this mock
          // alive too: AbortSignal.timeout's timer is unref'ed on Node 20.
          const pendingIo = setInterval(() => {}, 1_000);
          init.signal.addEventListener("abort", () => {
            clearInterval(pendingIo);
            reject(init.signal.reason);
          }, { once: true });
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

// ---- 1.0.20: cache, opt-outs, prereleases, tighter timeout ----

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NO_UPDATE_CHECK_ENV,
  UPDATE_CHECK_CACHE_TTL_MS,
  UPDATE_CHECK_TIMEOUT_MS,
  updateCheckEnabled,
} from "../dist/update-check.js";

function tmpCacheFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-update-check-"));
  return path.join(dir, "update-check.json");
}

test("the registry fetch is bounded to at most 1.5 seconds", () => {
  assert.ok(UPDATE_CHECK_TIMEOUT_MS <= 1500, String(UPDATE_CHECK_TIMEOUT_MS));
});

test("an older installed version gets the hint and the answer is cached", async () => {
  const cacheFile = tmpCacheFile();
  const { fetchImpl, calls } = registry({ version: "1.0.20" });
  const result = await checkForUpdate({
    currentVersion: "1.0.14", fetchImpl, env: {}, cacheFile, now: () => 1_000,
  });
  assert.deepEqual(result, { latest: "1.0.20", current: "1.0.14" });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, "utf8")), {
    checkedAt: 1_000, latest: "1.0.20",
  });
});

test("a fresh cache answers without contacting the registry", async () => {
  const cacheFile = tmpCacheFile();
  fs.writeFileSync(cacheFile, JSON.stringify({ checkedAt: 1_000, latest: "1.0.20" }));
  const { fetchImpl, calls } = registry({ version: "9.9.9" });
  const now = () => 1_000 + UPDATE_CHECK_CACHE_TTL_MS - 1;
  assert.deepEqual(
    await checkForUpdate({ currentVersion: "1.0.14", fetchImpl, env: {}, cacheFile, now }),
    { latest: "1.0.20", current: "1.0.14" }
  );
  // After upgrading, the same cached answer is no longer an update.
  assert.equal(
    await checkForUpdate({ currentVersion: "1.0.20", fetchImpl, env: {}, cacheFile, now }),
    null
  );
  assert.equal(calls.length, 0, "cache hit must not fetch");
});

test("a stale, future-dated or corrupt cache is refreshed from the registry", async () => {
  const stale = { checkedAt: 1_000, latest: "1.0.15" };
  const cases = [
    ["stale", JSON.stringify(stale), 1_000 + UPDATE_CHECK_CACHE_TTL_MS + 1],
    ["future", JSON.stringify(stale), 0],
    ["corrupt", "{not json", 5_000],
    ["bad version", JSON.stringify({ checkedAt: 5_000, latest: "\u001b[2J" }), 5_000],
  ];
  for (const [name, contents, nowMs] of cases) {
    const cacheFile = tmpCacheFile();
    fs.writeFileSync(cacheFile, contents);
    const { fetchImpl, calls } = registry({ version: "1.0.20" });
    const result = await checkForUpdate({
      currentVersion: "1.0.14", fetchImpl, env: {}, cacheFile, now: () => nowMs,
    });
    assert.deepEqual(result, { latest: "1.0.20", current: "1.0.14" }, name);
    assert.equal(calls.length, 1, name);
  }
});

test("registry down or timing out: silent, and nothing is cached", async () => {
  for (const fetchImpl of [
    registry({ version: "9.9.9" }, 503).fetchImpl,
    async () => { throw new TypeError("fetch failed"); },
  ]) {
    const cacheFile = tmpCacheFile();
    assert.equal(
      await checkForUpdate({ currentVersion: "1.0.14", fetchImpl, env: {}, cacheFile }),
      null
    );
    assert.equal(fs.existsSync(cacheFile), false);
  }
});

test("an unwritable cache location never breaks the check", async () => {
  const { fetchImpl } = registry({ version: "1.0.20" });
  const cacheFile = path.join(tmpCacheFile(), "nested", "x", "update-check.json");
  fs.writeFileSync(path.dirname(path.dirname(path.dirname(cacheFile))), "file, not dir");
  assert.deepEqual(
    await checkForUpdate({ currentVersion: "1.0.14", fetchImpl, env: {}, cacheFile }),
    { latest: "1.0.20", current: "1.0.14" }
  );
});

test("a prerelease on the latest tag is never offered", async () => {
  for (const latest of ["1.0.21-beta.1", "2.0.0-rc.0"]) {
    const { fetchImpl } = registry({ version: latest });
    assert.equal(
      await checkForUpdate({ currentVersion: "1.0.14", fetchImpl, env: {} }),
      null,
      latest
    );
  }
});

test("opt-outs: CCC_NO_UPDATE_CHECK=1, CCC_SKIP_UPDATE_CHECK=1, updateCheck: false", async () => {
  const optedOut = [
    [{ [NO_UPDATE_CHECK_ENV]: "1" }, {}],
    [{ [SKIP_UPDATE_CHECK_ENV]: "1" }, {}],
    [{}, { updateCheck: false }],
  ];
  for (const [env, config] of optedOut) {
    assert.equal(updateCheckEnabled(env, config), false, JSON.stringify([env, config]));
    const { fetchImpl, calls } = registry({ version: "9.9.9" });
    const result = await checkForUpdate({
      currentVersion: "1.0.14", fetchImpl, env, config, cacheFile: tmpCacheFile(),
    });
    assert.equal(result, null);
    assert.equal(calls.length, 0, "registry must not be contacted");
  }
  assert.equal(updateCheckEnabled({ [NO_UPDATE_CHECK_ENV]: "0" }, { updateCheck: true }), true);
  assert.equal(updateCheckEnabled({}, {}), true);
});
