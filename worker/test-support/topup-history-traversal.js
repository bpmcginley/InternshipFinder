import assert from "node:assert/strict";
import {
  validateTopupHistoryTraversal as scan,
  HISTORY_TRAVERSAL_BOUNDS as cap,
} from "../src/topup-history-traversal.js";
import {
  rotateTopupCoverage as rotate,
  captureTopupCoverage as capture,
} from "../src/topup-history-coverage.js";
const on = { enabled: true };
const page = (events = [], has_more = false) => ({
  object: "list",
  url: "/v1/events",
  data: events,
  has_more,
});
const reply = (v) => new Response(JSON.stringify(v));
async function fixture(db) {
  await db.prepare("DELETE FROM topup_history_coverage").run();
  await rotate(db, { livemode: false, schemaKey: "synthetic", expected: null }, on);
  const row = await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now").first();
  const now = Date.parse(row.now);
  await db
    .prepare("UPDATE topup_history_coverage SET starts_at=?")
    .bind(new Date(now - 600000).toISOString())
    .run();
  const expected = (await capture(db, false, on)).coverage;
  const input = {
    livemode: false,
    expected,
    schemaKey: "synthetic",
    apiVersions: ["fixture-v1"],
    from: Math.floor(now / 1000) - 120,
    to: Math.floor(now / 1000) - 60,
  };
  const event = (id = "a", created = input.from) => ({
    object: "event",
    id: "evt_" + id,
    api_version: "fixture-v1",
    created,
    livemode: false,
    type: "charge.updated",
    data: { object: { id: "ch_synthetic" } },
  });
  return { input, now, event, options: { enabled: true, clock: () => now } };
}
const current = async (db) => (await capture(db, false, on)).coverage;

export async function disabledAndBadConfigNeverReadPages(db) {
  const f = await fixture(db);
  const live = await rotate(db, { livemode: true, schemaKey: "synthetic", expected: null }, on);
  let calls = 0;
  const options = {
    ...f.options,
    readPage: () => {
      calls++;
      throw new Error();
    },
  };
  assert.equal((await scan(db, f.input, { ...options, enabled: "true" })).status, "disabled");
  for (const input of [
    { ...f.input, livemode: true },
    { ...f.input, from: f.input.to },
    { ...f.input, to: f.input.to + 10000 },
    { ...f.input, from: 0 },
    { ...f.input, apiVersions: [] },
    { ...f.input, schemaKey: "other" },
  ])
    assert.equal((await scan(db, input, options)).status, "held");
  assert.equal(calls, 0);
  assert.deepEqual(await current(db), f.input.expected);
  assert.deepEqual((await capture(db, true, on)).coverage, live.coverage);
}
export async function terminalTraversalIsOnlyUnprovenAndEqualTimesUseIds(db) {
  const f = await fixture(db),
    queries = [];
  const result = await scan(db, f.input, {
    ...f.options,
    readPage: async (q) => {
      queries.push(q);
      return reply(
        queries.length === 1 ? page([f.event("z"), f.event("a")], true) : page([f.event("b")]),
      );
    },
  });
  assert.deepEqual(result, { status: "unproven" });
  assert.deepEqual(queries, [
    { created: { gte: f.input.from, lt: f.input.to }, limit: 100 },
    { created: { gte: f.input.from, lt: f.input.to }, limit: 100, starting_after: "evt_a" },
  ]);
  assert.deepEqual(await current(db), f.input.expected);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM topup_history_receipts").first()).n, 0);
}
async function envelopeFault(db, fault) {
  const f = await fixture(db);
  let value = page([f.event("a", f.input.from + 10), f.event("b", f.input.from + 9)]);
  if (fault === "mode") value.data[0].livemode = true;
  if (fault === "schema") value.data[0].api_version = "unsupported";
  if (fault === "duplicate") value.data[1].id = value.data[0].id;
  if (fault === "reorder") value.data[1].created = f.input.from + 11;
  if (fault === "before") value.data[0].created = f.input.from - 1;
  if (fault === "end") value.data[0].created = f.input.to;
  if (fault === "url") value.url = "/v1/charges";
  if (fault === "more") value.has_more = "false";
  if (fault === "empty") value = page([], true);
  if (fault === "type") value.data[0].type = "";
  if (fault === "object") value.data[0].data.object = [];
  if (fault === "oversize") value.data = Array.from({ length: 101 }, (_, i) => f.event(String(i)));
  let calls = 0;
  assert.equal(
    (
      await scan(db, f.input, {
        ...f.options,
        readPage: async () => {
          calls++;
          return reply(value);
        },
      })
    ).status,
    "closed",
    fault,
  );
  assert.equal(calls, 1);
  assert.deepEqual(await current(db), { ...f.input.expected, health: "closed", revision: 2 });
}
export const envelopeFaultMode = (db) => envelopeFault(db, "mode");
export const envelopeFaultSchema = (db) => envelopeFault(db, "schema");
export const envelopeFaultDuplicate = (db) => envelopeFault(db, "duplicate");
export const envelopeFaultReorder = (db) => envelopeFault(db, "reorder");
export const envelopeFaultBefore = (db) => envelopeFault(db, "before");
export const envelopeFaultEnd = (db) => envelopeFault(db, "end");
export const envelopeFaultUrl = (db) => envelopeFault(db, "url");
export const envelopeFaultMore = (db) => envelopeFault(db, "more");
export const envelopeFaultEmpty = (db) => envelopeFault(db, "empty");
export const envelopeFaultType = (db) => envelopeFault(db, "type");
export const envelopeFaultObject = (db) => envelopeFault(db, "object");
export const envelopeFaultOversize = (db) => envelopeFault(db, "oversize");
export async function repeatedCursorAndPageLimitNeverSkipEvents(db) {
  for (const duplicate of [true, false]) {
    const f = await fixture(db);
    let calls = 0;
    const result = await scan(db, f.input, {
      ...f.options,
      readPage: async () => reply(page([f.event(String(duplicate ? 0 : ++calls))], true)),
    });
    assert.equal(result.status, "closed");
    if (!duplicate) assert.equal(calls, cap.pages);
  }
}
export async function staleEpochAndRotationDuringPageNeverCloseAnotherEpoch(db) {
  const f = await fixture(db);
  let calls = 0;
  const next = await rotate(
    db,
    { livemode: false, schemaKey: "synthetic", expected: f.input.expected },
    on,
  );
  assert.equal(
    (
      await scan(db, f.input, {
        ...f.options,
        readPage: () => {
          calls++;
        },
      })
    ).status,
    "held",
  );
  assert.equal(calls, 0);
  assert.deepEqual(await current(db), next.coverage);
  const g = await fixture(db);
  let newer;
  assert.equal(
    (
      await scan(db, g.input, {
        ...g.options,
        readPage: async () => {
          newer = await rotate(
            db,
            { livemode: false, schemaKey: "next", expected: g.input.expected },
            on,
          );
          return reply(page());
        },
      })
    ).status,
    "held",
  );
  assert.deepEqual(await current(db), newer.coverage);
}
export async function deadlineAndClockRegressionFenceBeforeAnotherPage(db) {
  for (const delta of [cap.timeoutMs, -1]) {
    const f = await fixture(db);
    let now = f.now,
      calls = 0,
      response;
    const result = await scan(db, f.input, {
      ...f.options,
      clock: () => now,
      readPage: async () => {
        calls++;
        now += delta;
        response = reply(page([f.event()], true));
        return response;
      },
    });
    assert.equal(result.status, "closed");
    assert.equal(calls, 1);
    assert.equal(response.body.locked, false);
  }
}
async function transportFault(db, fault) {
  const f = await fixture(db);
  let calls = 0;
  const result = await scan(db, f.input, {
    ...f.options,
    readPage: async () => {
      calls++;
      if (fault === "body") return new Response("x".repeat(cap.bodyBytes + 1));
      if (fault === "length") return new Response("{}", { headers: { "Content-Length": "0" } });
      if (fault === "utf8") return new Response(new Uint8Array([0xff]));
      if (fault === "status") return new Response("private", { status: 500 });
      return reply({ ...page([f.event(String(calls))], true), padding: "x".repeat(180000) });
    },
  });
  assert.equal(result.status, "closed", fault);
  assert.equal(calls, fault === "aggregate" ? 3 : 1);
}
export const transportFaultBody = (db) => transportFault(db, "body");
export const transportFaultLength = (db) => transportFault(db, "length");
export const transportFaultUtf8 = (db) => transportFault(db, "utf8");
export const transportFaultAggregate = (db) => transportFault(db, "aggregate");
export const transportFaultStatus = (db) => transportFault(db, "status");
export async function lateNoncooperativeTransportCannotReleaseOrRetry(db) {
  const f = await fixture(db);
  let resolve,
    calls = 0,
    cancelled = 0;
  const result = await scan(db, f.input, {
    ...f.options,
    timeoutMs: 10,
    readPage: () => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  assert.equal(result.status, "closed");
  assert.equal(calls, 1);
  resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
    ),
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cancelled, 1);
  assert.equal((await current(db)).revision, 2);
}
export async function failedTransportAndUnknownClosureReceiptNeverRetry(db) {
  const f = await fixture(db);
  let writes = 0,
    pages = 0;
  const uncertain = {
    prepare: db.prepare.bind(db),
    async batch(statements) {
      const rows = await db.batch(statements);
      if (statements.length === 2) {
        writes++;
        throw new Error("private receipt");
      }
      return rows;
    },
  };
  const result = await scan(uncertain, f.input, {
    ...f.options,
    readPage: async () => {
      pages++;
      throw new Error("private transport");
    },
  });
  assert.deepEqual(result, { status: "held" });
  assert.equal(writes, 1);
  assert.equal(pages, 1);
  assert.equal((await current(db)).health, "closed");
  assert.equal((await current(db)).revision, 2);
}
export async function rejectingClockSamplesAreDrainedWithoutExposure(db) {
  for (const after of [false, true]) {
    const f = await fixture(db);
    let reject = false,
      pages = 0;
    const result = await scan(db, f.input, {
      ...f.options,
      clock: () => (!after || reject ? Promise.reject(new Error("private clock")) : f.now),
      readPage: async () => {
        pages++;
        reject = true;
        return reply(page());
      },
    });
    assert.equal(result.status, after ? "closed" : "held");
    assert.equal(pages, after ? 1 : 0);
    await new Promise((r) => setTimeout(r, 0));
  }
}

export async function stalledBodyIsCancelledAndNoPrefixEscapes(db) {
  const f = await fixture(db);
  let cancelled = 0,
    calls = 0,
    response;
  const result = await scan(db, f.input, {
    ...f.options,
    timeoutMs: 15,
    readPage: async () => {
      calls++;
      response = new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"object":"list"'));
          },
          cancel() {
            cancelled++;
          },
        }),
      );
      return response;
    },
  });
  assert.deepEqual(result, { status: "closed" });
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
  assert.equal(response.body.locked, false);
  assert.equal((await current(db)).revision, 2);
}
