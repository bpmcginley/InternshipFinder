import test from "node:test";
import assert from "node:assert/strict";
import { createEmployerCatalogCache } from "../src/employer-catalog-cache.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const response = (keys = ["acme"]) => new Response(JSON.stringify(keys));
function fixture(options = {}) {
  let clock = 0,
    loads = 0,
    parses = 0,
    next = 0;
  const timers = new Map(),
    signals = [];
  const cache = createEmployerCatalogCache({
    maxBytes: 64,
    loadTimeoutMs: options.loadTimeoutMs,
    now: () => clock,
    schedule: (fn, delay) => {
      const id = ++next;
      timers.set(id, { fn, at: clock + delay });
      return id;
    },
    cancel: (id) => timers.delete(id),
    load: (signal) => {
      loads++;
      signals.push(signal);
      return options.load ? options.load(signal) : response();
    },
    parse: (text) => {
      parses++;
      if (options.parse) return options.parse(text);
      // Fixture parser only: production wiring must reuse the existing core validator.
      const keys = JSON.parse(text);
      if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string")) return null;
      const members = new Set(keys);
      return (key) => members.has(key);
    },
  });
  return {
    cache,
    signals,
    timers,
    loads: () => loads,
    parses: () => parses,
    set: (value) => {
      clock = value;
    },
    fire: () => {
      for (const [id, timer] of timers)
        if (timer.at <= clock) {
          timers.delete(id);
          timer.fn();
        }
    },
  };
}

test("catalog fetch and validation are single-flight; membership checks expose no keys", async () => {
  const gate = deferred();
  const f = fixture({
    parse: async () => {
      await gate.promise;
      return (key) => key === "acme";
    },
  });
  const attempts = Array.from({ length: 12 }, () => f.cache.has("acme"));
  gate.resolve();
  assert.deepEqual(await Promise.all(attempts), Array(12).fill(true));
  assert.equal(f.loads(), 1);
  assert.equal(f.parses(), 1);
  assert.equal(await f.cache.has("unknown"), false);
  assert.deepEqual(Object.keys(f.cache), ["match", "has"]);
  assert.equal(Object.isFrozen(f.cache), true);
  assert.equal(f.timers.size, 0);
});

test("a matched catalog still has to be current when the caller resumes", async () => {
  const f = fixture();
  const isCurrent = await f.cache.match("acme");
  assert.equal(isCurrent(299_999), true);
  assert.equal(isCurrent(300_000), false);
  f.set(300_000);
  assert.equal(await f.cache.has("acme"), true);
  assert.equal(isCurrent(299_999), false);
});

test("catalog expires at exactly 300 seconds from load start, not validation completion", async () => {
  const gate = deferred();
  const f = fixture({ load: () => (f.loads() === 1 ? gate.promise : response(["newco"])) });
  const first = f.cache.has("acme");
  f.set(200_000);
  gate.resolve(response());
  assert.equal(await first, true);
  f.set(299_999);
  assert.equal(await f.cache.has("acme"), true);
  f.set(300_000);
  assert.equal(await f.cache.has("acme"), false);
  assert.equal(await f.cache.has("newco"), true);
  assert.equal(f.loads(), 2);
});

test("failed refresh clears stale data and retries only after five seconds", async () => {
  const f = fixture({
    load: () => {
      if (f.loads() === 2) throw new Error("fixture failure");
      return response();
    },
  });
  assert.equal(await f.cache.has("acme"), true);
  f.set(300_000);
  assert.equal(await f.cache.has("acme"), false);
  assert.deepEqual(
    await Promise.all(Array.from({ length: 20 }, () => f.cache.has("acme"))),
    Array(20).fill(false),
  );
  f.set(304_999);
  assert.equal(await f.cache.has("acme"), false);
  assert.equal(f.loads(), 2);
  f.set(305_000);
  assert.equal(await f.cache.has("acme"), true);
  assert.equal(f.loads(), 3);
});

test("oversize, malformed, failed and invalid UTF-8 responses fail closed before acceptance", async () => {
  const loaders = [
    () => new Response("[]", { headers: { "content-length": "65" } }),
    () => new Response("[]", { headers: { "content-length": "-1" } }),
    () => new Response(new Uint8Array(65)),
    () => new Response(new Uint8Array([0xc3, 0x28])),
    () => new Response("not json"),
    () => new Response("null"),
    () => new Response("[]", { status: 503 }),
    () => new Response(null, { status: 204 }),
    () => ({ ok: true, headers: new Headers(), body: {} }),
  ];
  for (const load of loaders) {
    const f = fixture({ load });
    assert.equal(await f.cache.has("acme"), false);
    assert.equal(await f.cache.has("acme"), false);
    assert.equal(f.loads(), 1);
    assert.equal(f.signals[0].aborted, true);
  }
});

test("timeout releases waiters, aborts load and rejects late publication", async () => {
  const gate = deferred();
  const f = fixture({ load: () => (f.loads() === 1 ? gate.promise : response(["newco"])) });
  const first = f.cache.has("acme"),
    second = f.cache.has("acme");
  f.set(300_000);
  f.fire();
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(f.signals[0].aborted, true);
  f.set(305_000);
  assert.equal(await f.cache.has("newco"), true);
  gate.resolve(response());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(await f.cache.has("acme"), false);
  assert.equal(await f.cache.has("newco"), true);
});

test("short load deadline releases stalled callers without shortening snapshot validity", async () => {
  const gate = deferred();
  const f = fixture({
    loadTimeoutMs: 5_000,
    load: () => (f.loads() === 1 ? gate.promise : response()),
  });
  const pending = f.cache.has("acme");
  f.set(5_000);
  f.fire();
  assert.equal(await pending, false);
  assert.equal(f.signals[0].aborted, true);
  f.set(10_000);
  assert.equal(await f.cache.has("acme"), true);
  f.set(309_999);
  assert.equal(await f.cache.has("acme"), true);
  assert.equal(f.loads(), 2);
  gate.resolve(response(["late"]));
  assert.equal(await f.cache.has("late"), false);
});

test("delayed body or validation cannot cross the hard deadline even without timer delivery", async () => {
  for (const phase of ["body", "validation"]) {
    const gate = deferred(),
      entered = deferred();
    const f = fixture(
      phase === "body"
        ? {
            load: () =>
              new Response(
                new ReadableStream({
                  async pull(controller) {
                    entered.resolve();
                    await gate.promise;
                    controller.enqueue(new TextEncoder().encode('["acme"]'));
                    controller.close();
                  },
                }),
              ),
          }
        : {
            parse: async () => {
              entered.resolve();
              await gate.promise;
              return () => true;
            },
          },
    );
    const pending = f.cache.has("acme");
    await entered.promise;
    await Promise.resolve();
    f.set(300_000);
    gate.resolve();
    assert.equal(await pending, false);
  }
});

test("invalid or backward clocks drop warm data and in-flight generations", async () => {
  for (const invalid of [NaN, Infinity, -1, 1.5]) {
    const f = fixture();
    f.set(100);
    assert.equal(await f.cache.has("acme"), true);
    f.set(invalid);
    assert.equal(await f.cache.has("acme"), false);
    f.set(101);
    assert.equal(await f.cache.has("acme"), false);
  }
  const gate = deferred(),
    f = fixture({ load: () => gate.promise });
  f.set(100);
  const pending = f.cache.has("acme");
  f.set(99);
  assert.equal(await f.cache.has("acme"), false);
  assert.equal(await pending, false);
  gate.resolve(response());
  await Promise.resolve();
  f.set(101);
  assert.equal(await f.cache.has("acme"), false);
});

test("membership errors, invalid results or crossing expiry fail closed", async () => {
  for (const predicate of [
    () => {
      throw new Error("fixture");
    },
    () => "yes",
  ]) {
    const f = fixture({ parse: () => predicate });
    assert.equal(await f.cache.has("acme"), false);
    assert.equal(await f.cache.has("acme"), false);
    assert.equal(f.loads(), 1);
  }
  const f = fixture({
    parse: () => () => {
      f.set(300_000);
      return true;
    },
  });
  assert.equal(await f.cache.has("acme"), false);
});

// Bounded streaming must count bytes, not characters, while decoding split UTF-8 safely.
test("catalog accepts its exact byte bound and rejects one extra streamed byte", async () => {
  for (const exact of [true, false]) {
    const body = new TextEncoder().encode(
      JSON.stringify(["é".repeat(29) + (exact ? "aa" : "aaa")]),
    );
    assert.equal(body.byteLength, exact ? 64 : 65);
    const f = fixture({
      load: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let i = 0; i < body.length; i++) controller.enqueue(body.slice(i, i + 1));
              controller.close();
            },
          }),
        ),
    });
    assert.equal(await f.cache.has("é".repeat(29) + (exact ? "aa" : "aaa")), exact);
    assert.equal(f.parses(), exact ? 1 : 0);
  }
});
