import assert from "node:assert/strict";
import test from "node:test";
import { handle } from "../src/index.js";
import { createFollowTokenEndpoints } from "../src/follow-token-endpoint.js";

const TOKEN = "10000000-0000-4000-8000-000000000001." + "a".repeat(64);
const CONFIRM = "https://api.example.test/follows/confirm";
const DELETE = "https://api.example.test/follows/delete-request";
const now = () => new Date("2026-11-12T12:00:00Z");
const noDb = { prepare: () => assert.fail("Unexpected storage access") };
const call = (request, DB = noDb) =>
  handle(request, { DB }, undefined, { now, fetch: () => assert.fail("Unexpected fetch") });
const post = (url, body, headers) =>
  new Request(url, { method: "POST", body, headers, duplex: "half" });

async function expectStatus(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.has("Location"), false);
  assert.equal(await response.text(), "");
}

test("only bounded body credentials reach the explicit follow POST routes", async () => {
  for (const [url, token] of [
    [CONFIRM, TOKEN],
    [DELETE, "fd_" + TOKEN],
  ]) {
    for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
      assert.equal((await call(new Request(url + "?token=" + token, { method }))).status, 404);
    }
    for (const request of [
      post(url + "?token=" + token, token),
      post(url, null, { Authorization: "Bearer " + token, Cookie: "token=" + token }),
      post(url, token, { "Content-Type": "application/json" }),
      post(url, token, { "Content-Length": "10000" }),
      post(url, token + "\n"),
      post(url, "\uFEFF" + token),
      post(url, token.slice(0, -1)),
      post(url, token.replace(/a$/, "X")),
      post(url, url === CONFIRM ? "fd_" + token : TOKEN),
      post(
        url,
        new ReadableStream({
          start: (c) => {
            c.enqueue(new TextEncoder().encode(token));
            c.enqueue(new Uint8Array([0]));
            c.close();
          },
        }),
        { "Content-Type": "text/plain" },
      ),
    ]) {
      await expectStatus(await call(request), 400);
    }
  }
});

test("body timeout cancels held readers in both actions and recovers shared capacity", async () => {
  const scheduled = new Map();
  let elapsed = 0;
  const timers = {
    monotonicNow: () => elapsed,
    setTimeout(fn, ms) {
      assert.equal(ms, 5000);
      const id = Symbol();
      scheduled.set(id, fn);
      return id;
    },
    clearTimeout: (id) => scheduled.delete(id),
  };
  const endpoints = createFollowTokenEndpoints(timers);
  let canceled = 0;
  let stream;
  const body = (token) =>
    new ReadableStream({
      start: (c) => {
        stream = c;
        c.enqueue(new TextEncoder().encode(token));
      },
      cancel: () => {
        canceled += 1;
      },
    });
  const requests = [
    [endpoints.confirm, CONFIRM, TOKEN],
    [endpoints.deleteRequest, DELETE, "fd_" + TOKEN],
    [endpoints.confirm, CONFIRM, TOKEN],
    [endpoints.deleteRequest, DELETE, "fd_" + TOKEN],
  ];
  const pending = requests.map(([endpoint, url, token]) =>
    endpoint(post(url, body(token), { "Content-Type": "text/plain" }), noDb, now),
  );
  const saturated = await endpoints.confirm(post(CONFIRM, TOKEN), noDb, now);
  assert.equal(saturated.headers.get("Retry-After"), "60");
  await expectStatus(saturated, 503);
  assert.equal(scheduled.size, 4);
  for (const fire of [...scheduled.values()]) fire();
  for (const response of await Promise.all(pending)) await expectStatus(response, 503);
  assert.equal(canceled, 4);
  assert.equal(scheduled.size, 0);
  await expectStatus(await endpoints.confirm(post(CONFIRM, ""), noDb, now), 400);

  let storageCalls = 0;
  const late = endpoints.confirm(
    post(CONFIRM, body(TOKEN), { "Content-Type": "text/plain" }),
    {
      prepare: () => {
        storageCalls += 1;
        throw new Error("Late read reached storage");
      },
    },
    now,
  );
  // Complete the stream at the cutoff with its timer callback still held.
  elapsed = 5000;
  stream.close();
  await expectStatus(await late, 503);
  assert.equal(storageCalls, 0);
  assert.equal(scheduled.size, 0);
});

test("storage faults are retryable and do not log internal error or request credentials", async () => {
  const original = console.error;
  const seen = [];
  console.error = (...parts) => seen.push(parts);
  try {
    const DB = {
      prepare: () => {
        throw new Error(TOKEN);
      },
    };
    for (const request of [post(CONFIRM, TOKEN), post(DELETE, "fd_" + TOKEN)]) {
      const response = await call(request, DB);
      assert.equal(response.headers.get("Retry-After"), "60");
      await expectStatus(response, 503);
    }
    assert.deepEqual(seen, []);
  } finally {
    console.error = original;
  }
});

test(
  "a body deadline cannot release capacity while a database action is settling",
  { timeout: 5000 },
  async () => {
    let releaseWrites;
    let signalAllStarted;
    const writes = new Promise((resolve) => {
      releaseWrites = resolve;
    });
    const allStarted = new Promise((resolve) => {
      signalAllStarted = resolve;
    });
    let started = 0;
    const pending = new Set();
    const endpoints = createFollowTokenEndpoints({
      monotonicNow: () => 0,
      setTimeout() {
        const id = Symbol();
        pending.add(id);
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
    });
    const DB = {
      prepare: () => ({ bind: () => ({}) }),
      batch: async () => {
        started += 1;
        if (started === 4) signalAllStarted();
        await writes;
        return Array.from({ length: 4 }, () => ({ meta: { changes: 0 } }));
      },
    };
    const actions = Array.from({ length: 4 }, () =>
      endpoints.confirm(post(CONFIRM, TOKEN), DB, now),
    );
    await allStarted;
    assert.equal(pending.size, 0);
    await expectStatus(await endpoints.deleteRequest(post(DELETE, "fd_" + TOKEN), noDb, now), 503);
    releaseWrites();
    for (const response of await Promise.all(actions)) await expectStatus(response, 410);
    await expectStatus(await endpoints.deleteRequest(post(DELETE, "invalid"), noDb, now), 400);
  },
);
