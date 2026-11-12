import assert from "node:assert/strict";
import { createFollowManagementRequestHttp as create } from "../src/follow-management-request-http.js";

const API = "https://api.example.test/follows/manage/request";
const SITE = "https://example.test";
const json = JSON.stringify({ email: "reader@example.test" });
const originAllowed = (r) => r.headers.get("Origin") === SITE;
const options = { enabled: true, originAllowed, ttlMs: 60000, dailyLimit: 50 };
const request = (body = json, headers = {}, url = API) =>
  new Request(url, {
    method: "POST",
    body,
    duplex: "half",
    headers: { Origin: SITE, "Content-Type": "application/json", ...headers },
  });
const forbidden = {
  prepare() {
    assert.fail("Unexpected storage");
  },
  batch() {
    assert.fail("Unexpected storage");
  },
};
async function response(r, status) {
  assert.equal(r.status, status);
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  assert.equal(r.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(r.headers.has("Set-Cookie"), false);
  assert.equal(r.headers.has("Location"), false);
  assert.equal(await r.text(), "");
}
async function seed(db) {
  await db
    .prepare(
      "INSERT INTO follow_subscribers(id,email,created) VALUES('reader','reader@example.test','2026-01-01T00:00:00.000Z')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO follow_subscriptions(subscriber_id,scope_key,created) VALUES('reader','public-scope','2026-01-01T00:00:00.000Z')",
    )
    .run();
}
const rows = async (db, table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results;

export async function disabledPolicyMethodAndOriginNeverReadBodyOrStorage() {
  let calls = 0;
  const untouched = {
    prepare() {
      calls++;
      throw new Error();
    },
    batch() {
      calls++;
      throw new Error();
    },
  };
  for (const override of [
    { enabled: false },
    { enabled: "true" },
    { ttlMs: undefined },
    { ttlMs: 604800001 },
    { dailyLimit: 0 },
    { dailyLimit: 1.5 },
  ]) {
    const r = request();
    await response(await create({ db: untouched, ...options, ...override })(r), 503);
    assert.equal(r.bodyUsed, false);
  }
  const handler = create({ db: untouched, ...options });
  const get = await handler(new Request(API));
  assert.equal(get.headers.get("Allow"), "POST");
  await response(get, 405);
  for (const origin of ["", "null", "https://foreign.example.test"]) {
    const r = request(json, {
      Origin: origin,
      Cookie: "ignored=1",
      Authorization: "Bearer irrelevant",
    });
    await response(await handler(r), 403);
    assert.equal(r.bodyUsed, false);
  }
  assert.equal(calls, 0);
  for (const policy of [
    async () => true,
    async () => {
      throw new Error("private");
    },
    () => 1,
  ])
    await response(
      await create({ db: forbidden, ...options, originAllowed: policy })(request()),
      403,
    );
}

export async function malformedExactShapeAndTransportNeverReachEnqueue() {
  const handler = create({ db: forbidden, ...options });
  for (const suffix of ["?", "#", "?email=untrusted", "#token=untrusted"])
    await response(await handler(request(json, {}, API + suffix)), 400);
  for (const type of [
    "text/plain",
    "application/json; charset=latin1",
    "application/json, application/json",
  ])
    await response(await handler(request(json, { "Content-Type": type })), 415);
  for (const length of ["0", "-1", "1e2", "16385", "1"])
    await response(await handler(request(json, { "Content-Length": length })), 400);
  for (const body of [
    null,
    "",
    "{}",
    "[]",
    "null",
    "{",
    new Uint8Array([0xff]),
    "\uFEFF" + json,
    '{"email":null}',
    '{"email":"invalid"}',
    '{"email":"a@example.test","extra":true}',
    '{"email":"a@example.test","email":"b@example.test"}',
    '{"email":"a@example.test","\\u0065mail":"b@example.test"}',
    '{"email":{"email":"a@example.test"}}',
    '{"email":["a@example.test"]}',
  ])
    await response(await handler(request(body)), 400);
  let cancelled = 0;
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(16385));
    },
    cancel() {
      cancelled++;
    },
  });
  await response(await handler(request(body)), 400);
  assert.equal(cancelled, 1);
}

export async function absentDuplicateAndNormalizedInboxShareGenericReceipt(db) {
  const handler = create({ db, ...options });
  await response(await handler(request()), 202);
  assert.equal((await rows(db, "follow_subscribers")).length, 0);
  await seed(db);
  await response(
    await handler(
      request('{"\\u0065mail":" READER@EXAMPLE.TEST "}', {
        "Content-Type": 'application/json; charset="UTF-8"',
        Cookie: "ignored=1",
      }),
    ),
    202,
  );
  const before = await rows(db, "follow_management_outbox");
  await response(await handler(request()), 202);
  assert.deepEqual(await rows(db, "follow_management_outbox"), before);
  assert.equal(before.length, 1);
  assert.equal((await rows(db, "rate"))[0].calls, 3);
  assert.equal((await rows(db, "follow_subscriptions"))[0].confirmed_at, null);
}

export async function concurrentRequestsRespectExistingAnonymousDailyCap(db) {
  await seed(db);
  const handler = create({ db, ...options, dailyLimit: 1 });
  const results = await Promise.all([handler(request()), handler(request()), handler(request())]);
  assert.deepEqual(results.map((r) => r.status).sort(), [202, 503, 503]);
  assert.equal((await rows(db, "rate"))[0].calls, 1);
  assert.equal((await rows(db, "follow_management_outbox")).length, 1);
}

export async function committedAmbiguousQueueReceiptNeverRetriesOrEchoes(db) {
  await seed(db);
  let batches = 0;
  const ambiguous = {
    prepare: (sql) => db.prepare(sql),
    async batch(statements) {
      const result = await db.batch(statements);
      if (++batches === 2) throw new Error("private synthetic detail");
      return result;
    },
  };
  await response(await create({ db: ambiguous, ...options })(request()), 503);
  assert.equal(batches, 2);
  assert.equal((await rows(db, "rate"))[0].calls, 1);
  assert.equal((await rows(db, "follow_management_outbox")).length, 1);
}

export async function fourSlotsRemainHeldThroughStorage(db) {
  let release, entered;
  const gate = new Promise((r) => {
    release = r;
  });
  const allEntered = new Promise((r) => {
    entered = r;
  });
  let calls = 0;
  const held = {
    prepare: (sql) => db.prepare(sql),
    async batch(statements) {
      if (statements.length === 1) {
        if (++calls === 4) entered();
        await gate;
      }
      return db.batch(statements);
    },
  };
  const handler = create({ db: held, ...options });
  const pending = Array.from({ length: 4 }, () => handler(request()));
  await allEntered;
  const fifth = request();
  await response(await handler(fifth), 503);
  assert.equal(fifth.bodyUsed, false);
  release();
  for (const r of await Promise.all(pending)) await response(r, 202);
  await response(await handler(request()), 202);
}

export async function stalledBodiesHaveAbsoluteDeadlineAndReleaseSlots(db) {
  const alarms = new Map();
  let next = 0,
    now = 0,
    cancelled = 0;
  const timers = {
    monotonicNow: () => now,
    setTimeout(fn) {
      const id = ++next;
      alarms.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      alarms.delete(id);
    },
  };
  const handler = create({ db, ...options, timers });
  const pending = Array.from({ length: 4 }, () =>
    handler(
      request(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
      ),
    ),
  );
  assert.equal(alarms.size, 4);
  await response(await handler(request()), 503);
  now = 5000;
  for (const alarm of [...alarms.values()]) alarm();
  for (const r of await Promise.all(pending)) await response(r, 503);
  assert.equal(cancelled, 4);
  assert.equal((await rows(db, "rate")).length, 0);
  await response(await handler(request()), 202);
}

export async function elapsedDeadlineCannotBeResetByChunks(db) {
  let now = 0,
    cancelled = 0;
  const timers = { monotonicNow: () => now, setTimeout: () => 1, clearTimeout() {} };
  let chunk = 0;
  const body = new ReadableStream({
    pull(c) {
      if (chunk++ === 0) c.enqueue(new TextEncoder().encode('{"email":'));
      else {
        now = 5000;
        c.enqueue(new TextEncoder().encode('"reader@example.test"}'));
      }
    },
    cancel() {
      cancelled++;
    },
  });
  await response(await create({ db, ...options, timers })(request(body)), 503);
  assert.equal(cancelled, 1);
  assert.equal((await rows(db, "rate")).length, 0);
}

export async function unavailableStorageIsGenericAndNoAutomaticRetry() {
  let calls = 0;
  const db = {
    prepare() {
      calls++;
      throw new Error("private details");
    },
  };
  await response(await create({ db, ...options })(request()), 503);
  assert.equal(calls, 1);
}
