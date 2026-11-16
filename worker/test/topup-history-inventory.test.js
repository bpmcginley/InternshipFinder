import test from "node:test";
import assert from "node:assert/strict";
import { inventoryTopupHistory } from "../src/topup-history-inventory.js";

const now = Date.parse("2026-11-12T12:00:00Z");
const to = now / 1000,
  from = to - 60;
const input = () => ({ from, to, livemode: false, apiVersions: ["2026-01-01", "2026-02-01"] });
const policy = () => ({
  method: "GET",
  redirect: "manual",
  credentials: "omit",
  cache: "no-store",
});
const event = (extra = {}) => ({
  object: "event",
  id: "evt_synthetic",
  created: from,
  livemode: false,
  api_version: "2026-01-01",
  type: "refund.created",
  data: {
    object: { object: "refund", id: "re_not_retained", metadata: { private: "never_return" } },
  },
  ...extra,
});
const page = (data = [], has_more = false) => ({
  object: "list",
  url: "/v1/events",
  data,
  has_more,
});
const response = (value) => new Response(JSON.stringify(value));
const options = (readPage, extra = {}) => ({
  enabled: true,
  clock: () => now,
  requestPolicy: policy(),
  readPage,
  ...extra,
});
const unavailable = { status: "unavailable" };

test("inventory is default off and malformed policy/config has zero I/O", async () => {
  let calls = 0;
  const read = () => {
    calls++;
    throw Error();
  };
  assert.deepEqual(await inventoryTopupHistory(input(), { readPage: read }), {
    status: "disabled",
  });
  for (const change of [
    { livemode: undefined },
    { apiVersions: [] },
    { apiVersions: ["a", "a"] },
    { from: to - 3601 },
    { to: to + 1 },
    { from: 1 },
    { apiVersions: new Array(1) },
  ])
    assert.deepEqual(
      await inventoryTopupHistory({ ...input(), ...change }, options(read)),
      unavailable,
    );
  for (const change of [
    { method: "POST" },
    { redirect: "follow" },
    { credentials: "include" },
    { cache: "default" },
    { authorization: "not_allowed" },
  ])
    assert.deepEqual(
      await inventoryTopupHistory(
        input(),
        options(read, { requestPolicy: { ...policy(), ...change } }),
      ),
      unavailable,
    );
  assert.equal(calls, 0);
});

test("redacted inventory counts fixed families and schema slots without echoing raw labels or payloads", async () => {
  const data = [
    event(),
    event({
      id: "evt_2",
      type: "charge.dispute.created",
      data: { object: { object: "dispute" } },
      api_version: "2026-02-01",
    }),
    event({
      id: "evt_3",
      type: "charge.refunded",
      data: { object: { object: "charge" } },
      api_version: null,
    }),
    event({
      id: "evt_4",
      type: "synthetic_sensitive.private_marker",
      api_version: "private_schema_marker",
    }),
  ];
  const result = await inventoryTopupHistory(
    input(),
    options(async (query, signal, requestPolicy) => {
      assert.deepEqual(query, { created: { gte: from, lt: to }, limit: 100 });
      assert.ok(
        Object.isFrozen(query) && Object.isFrozen(query.created) && Object.isFrozen(requestPolicy),
      );
      assert.ok(signal instanceof AbortSignal);
      assert.deepEqual({ ...requestPolicy }, policy());
      return response(page(data));
    }),
  );
  assert.deepEqual(result, {
    status: "observed_inventory",
    pages: 1,
    events: 4,
    families: { refund: 1, dispute: 1, charge: 1, other: 1 },
    schemas: [1, 1],
    unknownSchema: 2,
  });
  for (const value of ["evt_", "re_not_retained", "private", "2026-", "never_return"])
    assert.equal(JSON.stringify(result).includes(value), false);
});

test("known event and object mismatch rejects rather than implying replay compatibility", async () => {
  assert.deepEqual(
    await inventoryTopupHistory(
      input(),
      options(async () => response(page([event({ data: { object: { object: "customer" } } })]))),
    ),
    unavailable,
  );
});

test("empty terminal inventory is not a coverage receipt", async () => {
  const result = await inventoryTopupHistory(
    input(),
    options(async () => response(page())),
  );
  assert.equal(result.status, "observed_inventory");
  assert.equal(result.events, 0);
  assert.equal("coverage" in result || "qualified" in result || "complete" in result, false);
});

test("bounded pagination uses only in-memory exact cursor and allows equal timestamps", async () => {
  let calls = 0;
  const result = await inventoryTopupHistory(
    input(),
    options(async (query) => {
      calls++;
      if (calls === 1) {
        assert.equal(query.starting_after, undefined);
        return response(page([event()], true));
      }
      assert.equal(query.starting_after, "evt_synthetic");
      return response(page([event({ id: "evt_next" })]));
    }),
  );
  assert.equal(calls, 2);
  assert.equal(result.events, 2);
  let capped = 0;
  assert.deepEqual(
    await inventoryTopupHistory(
      input(),
      options(async () => response(page([event({ id: "evt_" + ++capped })], true)), {
        limits: { pages: 2 },
      }),
    ),
    unavailable,
  );
  assert.equal(capped, 2);
});

test("invalid envelopes, identities, ordering, mode, account and terminal pages return no partial counts", async () => {
  const bad = [
    page([event(), event()]),
    page([event({ livemode: true })]),
    page([event({ account: "acct_fake" })]),
    page([event({ context: "ctx_fake" })]),
    page([event({ created: to })]),
    page([event({ created: from - 1 })]),
    page([event({ created: from + 1 }), event({ id: "evt_2", created: from + 2 })]),
    page([event({ id: "private" })]),
    page([event({ type: "bad" })]),
    page([event({ api_version: {} })]),
    page([], true),
    { ...page(), has_more: "false" },
    { ...page(), url: "/other" },
    page(Array.from({ length: 101 }, (_, i) => event({ id: "evt_" + i }))),
  ];
  for (const value of bad)
    assert.deepEqual(
      await inventoryTopupHistory(
        input(),
        options(async () => response(value)),
      ),
      unavailable,
    );
  let calls = 0;
  assert.deepEqual(
    await inventoryTopupHistory(
      input(),
      options(async () => response(calls++ ? page([]) : page([event()], true))),
    ),
    unavailable,
  );
});

test("duplicate decoded keys and malformed UTF-8 reject before returning inventory", async () => {
  for (const raw of [
    '{"object":"list","object":"list","url":"/v1/events","data":[],"has_more":false}',
    '{"object":"list","url":"/v1/events","data":[],"has_more":false,"has_\\u006dore":false}',
    new Uint8Array([0xff]),
  ])
    assert.deepEqual(
      await inventoryTopupHistory(
        input(),
        options(async () => new Response(raw)),
      ),
      unavailable,
    );
});

test("exact byte bounds pass and declared/actual excess or mismatch fail", async () => {
  const raw = JSON.stringify(page([event()])),
    size = new TextEncoder().encode(raw).length;
  assert.equal(
    (
      await inventoryTopupHistory(
        input(),
        options(async () => new Response(raw), { limits: { bodyBytes: size, totalBytes: size } }),
      )
    ).events,
    1,
  );
  for (const limits of [{ bodyBytes: size - 1 }, { totalBytes: size - 1 }])
    assert.deepEqual(
      await inventoryTopupHistory(
        input(),
        options(async () => new Response(raw), { limits }),
      ),
      unavailable,
    );
  for (const length of [String(size - 1), String(size + 1), "999999", "01"])
    assert.deepEqual(
      await inventoryTopupHistory(
        input(),
        options(async () => new Response(raw, { headers: { "content-length": length } })),
      ),
      unavailable,
    );
  let calls = 0;
  assert.deepEqual(
    await inventoryTopupHistory(
      input(),
      options(async () => response(page([event({ id: "evt_" + ++calls })], calls === 1)), {
        limits: { totalBytes: size + 20 },
      }),
    ),
    unavailable,
  );
});

test("split UTF-8 and empty chunks preserve bounded parsing", async () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify(page([event({ data: { object: { object: "refund", unused: "café" } } })])),
  );
  const result = await inventoryTopupHistory(
    input(),
    options(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array());
              for (const b of bytes) c.enqueue(new Uint8Array([b]));
              c.close();
            },
          }),
        ),
    ),
  );
  assert.equal(result.events, 1);
});

test("absolute clock deadline and clock regression reject late reads without another page", async () => {
  for (const delta of [100, -1]) {
    let time = now,
      calls = 0,
      canceled = 0;
    const result = await inventoryTopupHistory(
      input(),
      options(
        async () => {
          calls++;
          time += delta;
          return new Response(
            new ReadableStream({
              cancel() {
                canceled++;
              },
            }),
          );
        },
        { clock: () => time, limits: { timeoutMs: 50 } },
      ),
    );
    assert.deepEqual(result, unavailable);
    assert.equal(calls, 1);
    assert.equal(canceled, 1);
  }
});

test("noncooperative late page is discarded after deadline and no partial result escapes", async () => {
  let resolvePage,
    canceled = 0,
    signal;
  const pending = new Promise((resolve) => {
    resolvePage = resolve;
  });
  const result = await inventoryTopupHistory(
    input(),
    options(
      async (_, s) => {
        signal = s;
        return pending;
      },
      { limits: { timeoutMs: 10 } },
    ),
  );
  assert.deepEqual(result, unavailable);
  assert.equal(signal.aborted, true);
  resolvePage(
    new Response(
      new ReadableStream({
        cancel() {
          canceled++;
        },
      }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(canceled, 1);
});

test("noncooperative body cancel cannot delay timeout or late rejection cleanup", async () => {
  let rejectRead,
    canceled = 0;
  const source = new ReadableStream(
    {
      pull() {
        return new Promise((_, reject) => {
          rejectRead = reject;
        });
      },
      cancel() {
        canceled++;
        return new Promise(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  assert.deepEqual(
    await inventoryTopupHistory(
      input(),
      options(async () => new Response(source), { limits: { timeoutMs: 10 } }),
    ),
    unavailable,
  );
  assert.equal(canceled, 1);
  assert.equal(source.locked, false);
  rejectRead(new Error("late synthetic body error"));
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("input and options accessors are not invoked", async () => {
  let calls = 0;
  const value = input();
  Object.defineProperty(value, "livemode", {
    get() {
      calls++;
      return false;
    },
    enumerable: true,
  });
  assert.deepEqual(
    await inventoryTopupHistory(
      value,
      options(async () => response(page())),
    ),
    unavailable,
  );
  const o = options(async () => response(page()));
  Object.defineProperty(o, "readPage", {
    get() {
      calls++;
    },
    enumerable: true,
  });
  assert.deepEqual(await inventoryTopupHistory(input(), o), unavailable);
  assert.equal(calls, 0);
});

test("rejected asynchronous initial clock is drained before any I/O", async () => {
  let calls = 0;
  const result = await inventoryTopupHistory(
    input(),
    options(
      async () => {
        calls++;
        return response(page());
      },
      { clock: () => Promise.reject(new Error("synthetic clock rejection")) },
    ),
  );
  assert.deepEqual(result, unavailable);
  assert.equal(calls, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("rejected asynchronous clock after page await is drained and response canceled", async () => {
  let bad = false,
    canceled = 0,
    calls = 0;
  const result = await inventoryTopupHistory(
    input(),
    options(
      async () => {
        calls++;
        bad = true;
        return new Response(
          new ReadableStream({
            cancel() {
              canceled++;
            },
          }),
        );
      },
      { clock: () => (bad ? Promise.reject(new Error("synthetic clock rejection")) : now) },
    ),
  );
  assert.deepEqual(result, unavailable);
  assert.equal(calls, 1);
  assert.equal(canceled, 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("rejected asynchronous clock after body await is drained and reader released", async () => {
  let bad = false,
    canceled = 0;
  const stream = new ReadableStream(
    {
      pull(c) {
        bad = true;
        c.enqueue(new TextEncoder().encode(JSON.stringify(page())));
      },
      cancel() {
        canceled++;
      },
    },
    { highWaterMark: 0 },
  );
  const result = await inventoryTopupHistory(
    input(),
    options(async () => new Response(stream), {
      clock: () => (bad ? Promise.reject(new Error("synthetic clock rejection")) : now),
    }),
  );
  assert.deepEqual(result, unavailable);
  assert.equal(canceled, 1);
  assert.equal(stream.locked, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
});
