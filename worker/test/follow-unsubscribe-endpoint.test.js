import assert from "node:assert/strict";
import test from "node:test";
import { handle } from "../src/index.js";
import { createFollowUnsubscribeEndpoint } from "../src/follow-unsubscribe-endpoint.js";

const TOKEN = `10000000-0000-4000-8000-000000000001.${"a".repeat(64)}`;
const URL = `https://api.example.test/follows/unsubscribe?token=${TOKEN}`;
const NOW = new Date("2026-11-11T12:00:00Z");
const deps = { now: () => NOW, fetch: async () => assert.fail("No external transport") };
const post = (
  url = URL,
  body = new URLSearchParams({ "List-Unsubscribe": "One-Click" }),
  headers,
) => new Request(url, { method: "POST", body, headers });
const noDb = { prepare: () => assert.fail("No storage access") };
const dbFor = (run) => ({ prepare: () => ({ bind: () => ({ run }) }) });
const call = (request, DB = noDb, extra = {}) => handle(request, { DB, ...extra }, undefined, deps);
function fakeTimers() {
  let scheduled = 0;
  const active = new Map();
  return {
    get scheduled() {
      return scheduled;
    },
    active,
    setTimeout(fn, ms) {
      assert.equal(ms, 5000);
      active.set(++scheduled, fn);
      return scheduled;
    },
    clearTimeout(id) {
      active.delete(id);
    },
    expire() {
      for (const [id, fn] of [...active]) {
        active.delete(id);
        fn();
      }
    },
  };
}
const status = async (response, expected) => {
  assert.equal(response.status, expected);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.has("Location"), false);
  assert.equal(response.headers.has("Set-Cookie"), false);
  assert.equal(await response.text(), "");
};

test("fixed endpoint accepts anonymous mailbox forms without any signup/sending configuration", async () => {
  let calls = 0;
  const db = dbFor(async () => {
    calls += 1;
    return { meta: { changes: 0 } };
  });
  for (const body of [new URLSearchParams(), new FormData()]) {
    body.set("List-Unsubscribe", "One-Click");
    await status(await call(post(URL, body), db), 204);
  }
  // Cookie/Authorization cannot select a recipient; a foreign Origin is not an auth gate.
  await status(
    await call(
      post(URL, undefined, {
        Cookie: "session=synthetic",
        Authorization: "Bearer invalid",
        Origin: "https://mail.example.test",
      }),
      db,
    ),
    204,
  );
  assert.equal(calls, 3);
});

test("GET, HEAD, other methods and near routes never mutate; malformed POST never reaches D1", async () => {
  for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
    assert.equal((await call(new Request(URL, { method }))).status, 404);
  }
  assert.equal((await call(new Request(URL, { method: "OPTIONS" }))).status, 204);
  assert.equal((await call(post(URL.replace("unsubscribe?", "unsubscribe/extra?")))).status, 404);
  for (const url of [
    URL.split("?")[0],
    URL + `&token=${TOKEN}`,
    URL + "&extra=1",
    URL.replace(TOKEN, "invalid"),
    URL.replace(TOKEN, "fd_" + TOKEN),
    URL.replace(TOKEN, "x".repeat(300)),
  ])
    await status(await call(post(url)), 400);
  for (const body of ["", "List-Unsubscribe=One-Click&extra=1", "x".repeat(4097)]) {
    await status(
      await call(post(URL, body, { "Content-Type": "application/x-www-form-urlencoded" })),
      400,
    );
  }
  await status(
    await call(post(URL, "List-Unsubscribe=One-Click", { "Content-Type": "text/plain" })),
    400,
  );
  // Supplying the bearer in a cookie cannot repair a missing URL capability.
  await status(await call(post(URL.split("?")[0], undefined, { Cookie: `token=${TOKEN}` })), 400);
});

test("unavailable storage is retryable without logging request targets or internal errors", async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  try {
    for (const db of [
      undefined,
      dbFor(async () => {
        throw new Error(URL);
      }),
    ]) {
      const response = await call(post(), db);
      assert.equal(response.headers.get("Retry-After"), "60");
      await status(response, 503);
    }
  } finally {
    console.error = original;
  }
  assert.deepEqual(logged, []);
});

test("four in-flight slots bound storage work and release on completion or failure", async () => {
  const timers = fakeTimers();
  const endpoint = createFollowUnsubscribeEndpoint(timers);
  const releases = [];
  const db = dbFor(() => new Promise((resolve, reject) => releases.push({ resolve, reject })));
  const pending = Array.from({ length: 4 }, () => endpoint(post(), db, NOW));
  while (releases.length < 4) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(timers.scheduled, 4);
  assert.equal(timers.active.size, 0, "body deadlines are cleared before D1 begins");
  timers.expire(); // A body timer must never release a slot while deletion is still in flight.
  const busy = await endpoint(post(), noDb, NOW);
  assert.equal(busy.headers.get("Retry-After"), "60");
  await status(busy, 503);
  releases[0].reject(new Error("synthetic storage failure"));
  await status(await pending[0], 503);
  const fifth = endpoint(post(), db, NOW);
  while (releases.length < 5) await new Promise((resolve) => setTimeout(resolve, 0));
  for (const release of releases.slice(1)) release.resolve({ meta: { changes: 0 } });
  for (const response of await Promise.all([...pending.slice(1), fifth]))
    await status(response, 204);
  await status(await endpoint(post(URL.replace(TOKEN, "bad")), noDb, NOW), 400);
  await status(
    await endpoint(
      post(),
      dbFor(async () => ({ meta: { changes: 0 } })),
      NOW,
    ),
    204,
  );
});

test("one absolute body deadline cancels four stalled readers and frees slots without D1", async () => {
  const timers = fakeTimers();
  const endpoint = createFollowUnsubscribeEndpoint(timers);
  let cancelled = 0;
  const controllers = [];
  const pending = Array.from({ length: 4 }, () => {
    const body = new ReadableStream({
      start(controller) {
        controllers.push(controller);
      },
      cancel() {
        cancelled += 1;
        return new Promise(() => {});
      },
    });
    return endpoint(
      new Request(URL, {
        method: "POST",
        body,
        duplex: "half",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
      noDb,
      NOW,
    );
  });
  const encode = (text) => new TextEncoder().encode(text);
  controllers[1].enqueue(encode("List-Unsubscribe=One-Click")); // Complete field, but no EOF.
  controllers[2].enqueue(encode("List-Unsubscribe="));
  await Promise.resolve();
  controllers[2].enqueue(encode("One-Click"));
  await Promise.resolve();
  assert.equal(timers.scheduled, 4, "chunks cannot extend the original deadline");
  await status(await endpoint(post(), noDb, NOW), 503);
  timers.expire();
  for (const response of await Promise.all(pending)) {
    assert.equal(response.headers.get("Retry-After"), "60");
    await status(response, 503);
  }
  assert.equal(cancelled, 4);
  assert.equal(timers.active.size, 0);
  let writes = 0;
  await status(
    await endpoint(
      post(),
      dbFor(async () => {
        writes += 1;
        return { meta: { changes: 0 } };
      }),
      NOW,
    ),
    204,
  );
  assert.equal(writes, 1, "only the later complete request can reach storage");
});
