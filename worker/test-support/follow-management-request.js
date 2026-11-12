import assert from "node:assert/strict";
import { enqueueFollowManagementRequest as enqueue } from "../src/follow-management-request.js";

const input = { email: "reader@example.test" };
const options = { enabled: true, ttlMs: 1800000, dailyLimit: 50 };
const rows = async (db, table) =>
  (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results;
const jobs = (db) => rows(db, "follow_management_outbox");
const rate = async (db) =>
  (await rows(db, "rate")).filter((r) => r.user_hash === "*follow-management");
async function seed(db, confirmed = false) {
  await db
    .prepare(
      "INSERT INTO follow_subscribers(id,email,created) VALUES('fixture',?,'2026-01-01T00:00:00.000Z')",
    )
    .bind(input.email)
    .run();
  await db
    .prepare(
      "INSERT INTO follow_subscriptions(subscriber_id,scope_key,created,confirmed_at) VALUES('fixture','public-scope','2026-01-01T00:00:00.000Z',?)",
    )
    .bind(confirmed ? "2026-01-01T00:00:00.000Z" : null)
    .run();
}

export async function disabledMalformedAndBoundsNeverAccessStorage() {
  let calls = 0;
  const db = {
    prepare() {
      calls++;
      throw new Error();
    },
    batch() {
      calls++;
      throw new Error();
    },
  };
  assert.deepEqual(await enqueue(db, input), { status: "disabled" });
  for (const ttlMs of [undefined, null, "1000", 0, -1, 1.5, Infinity, 604800001])
    assert.deepEqual(await enqueue(db, input, { ...options, ttlMs }), { status: "unavailable" });
  for (const dailyLimit of [undefined, 0, -1, 1.5, Infinity])
    assert.deepEqual(await enqueue(db, input, { ...options, dailyLimit }), {
      status: "unavailable",
    });
  for (const value of [null, {}, [], { email: "invalid" }, { ...input, subscriberId: "fixture" }])
    assert.deepEqual(await enqueue(db, value, options), { status: "invalid" });
  assert.equal(calls, 0);
}

export async function genericUnknownOrphanAndDuplicatePreserveExistingState(db) {
  assert.deepEqual(await enqueue(db, input, options), { status: "accepted" });
  assert.deepEqual(await jobs(db), []);
  await seed(db);
  await db.prepare("DELETE FROM follow_subscriptions").run();
  assert.deepEqual(await enqueue(db, input, options), { status: "accepted" });
  assert.deepEqual(await jobs(db), []);
  await db
    .prepare(
      "INSERT INTO follow_subscriptions VALUES('fixture','public-scope','2026-01-01T00:00:00.000Z',NULL,NULL)",
    )
    .run();
  const scopes = await rows(db, "follow_subscriptions"),
    subscribers = await rows(db, "follow_subscribers");
  assert.deepEqual(await enqueue(db, { email: " READER@EXAMPLE.TEST " }, options), {
    status: "accepted",
  });
  const [first] = await jobs(db);
  assert.equal(Date.parse(first.expires_at) - Date.parse(first.queued_at), options.ttlMs);
  assert.deepEqual(await enqueue(db, input, { ...options, ttlMs: 604800000 }), {
    status: "accepted",
  });
  assert.deepEqual(await jobs(db), [first]);
  assert.deepEqual(await rows(db, "follow_subscriptions"), scopes);
  assert.deepEqual(await rows(db, "follow_subscribers"), subscribers);
  assert.deepEqual(await rows(db, "follow_tokens"), []);
  assert.equal((await rate(db))[0].calls, 4);
}

export async function concurrentRequestsRespectCapAndSingleLiveJob(db) {
  await seed(db, true);
  const results = await Promise.all(
    Array.from({ length: 12 }, () => enqueue(db, input, { ...options, dailyLimit: 3 })),
  );
  assert.equal(results.filter((r) => r.status === "accepted").length, 3);
  assert.equal(results.filter((r) => r.status === "unavailable").length, 9);
  assert.equal((await rate(db))[0].calls, 3);
  assert.equal((await jobs(db)).length, 1);
}

export async function expiryReplacesOnlyExpiredRequestAndDeletionCascades(db) {
  await seed(db, true);
  await enqueue(db, input, options);
  const [original] = await jobs(db);
  await db
    .prepare(
      "UPDATE follow_management_outbox SET queued_at='2020-01-01T00:00:00.000Z',expires_at='2020-01-01T00:00:01.000Z'",
    )
    .run();
  assert.deepEqual(await enqueue(db, input, { ...options, ttlMs: 604800000 }), {
    status: "accepted",
  });
  const [fresh] = await jobs(db);
  assert.notEqual(fresh.id, original.id);
  assert.equal(Date.parse(fresh.expires_at) - Date.parse(fresh.queued_at), 604800000);
  await db.prepare("DELETE FROM follow_subscribers WHERE id='fixture'").run();
  assert.deepEqual(await jobs(db), []);
  assert.deepEqual(await enqueue(db, input, options), { status: "accepted" });
  assert.deepEqual(await jobs(db), []);
  assert.deepEqual(await rows(db, "follow_subscribers"), []);
}

export async function deletionBetweenRateAndQueueNeverRecreatesSubscriber(db) {
  await seed(db);
  const wrapped = {
    batch: (s) => db.batch(s),
    prepare: (sql) => {
      if (!sql.startsWith("INSERT INTO rate")) return db.prepare(sql);
      return {
        bind: (...args) => ({
          run: async () => {
            const receipt = await db
              .prepare(sql)
              .bind(...args)
              .run();
            await db.prepare("DELETE FROM follow_subscribers WHERE id='fixture'").run();
            return receipt;
          },
        }),
      };
    },
  };
  assert.deepEqual(await enqueue(wrapped, input, options), { status: "accepted" });
  assert.deepEqual(await jobs(db), []);
  assert.deepEqual(await rows(db, "follow_subscribers"), []);
  assert.equal((await rate(db))[0].calls, 1);
}

export async function staleDatabaseDayCannotSpendNewDayQueue(db) {
  await seed(db);
  let count = 0;
  const wrapped = {
    prepare: (sql) => db.prepare(sql),
    batch: async (s) => {
      const receipt = await db.batch(s);
      if (++count === 1) receipt[0].results[0].day = "2020-01-01";
      return receipt;
    },
  };
  assert.deepEqual(await enqueue(wrapped, input, options), { status: "unavailable" });
  assert.deepEqual(await jobs(db), []);
  assert.equal((await rate(db))[0].bucket, "d:2020-01-01");
  assert.deepEqual(await enqueue(db, input, options), { status: "accepted" });
  assert.equal((await jobs(db)).length, 1);
  assert.equal((await rate(db)).length, 2);
}

export async function rollbackKeepsExpiredJobAndSpentBudget(db) {
  await seed(db);
  await enqueue(db, input, options);
  await db
    .prepare(
      "UPDATE follow_management_outbox SET queued_at='2020-01-01T00:00:00.000Z',expires_at='2020-01-01T00:00:01.000Z'",
    )
    .run();
  const before = await jobs(db);
  await db
    .prepare(
      "CREATE TRIGGER management_fixture_failure AFTER UPDATE ON follow_management_outbox BEGIN SELECT RAISE(ABORT,'fixture'); END",
    )
    .run();
  try {
    assert.deepEqual(await enqueue(db, input, options), { status: "unavailable" });
    assert.deepEqual(await jobs(db), before);
    assert.equal((await rate(db))[0].calls, 2);
  } finally {
    await db.prepare("DROP TRIGGER management_fixture_failure").run();
  }
}

export async function ambiguousCommittedReceiptsNeverRetryOrRevealInbox(db) {
  await seed(db);
  for (const fault of [
    "missing",
    "false",
    "changes",
    "results",
    "hole",
    "duplicate",
    "returnHole",
    "zeroWithWrite",
    "inflatedAggregate",
  ]) {
    await db.prepare("DELETE FROM follow_management_outbox").run();
    let calls = 0;
    const wrapped = {
      prepare: (sql) => db.prepare(sql),
      batch: async (s) => {
        const r = await db.batch(s);
        if (++calls === 2) {
          if (fault === "missing") r.pop();
          if (fault === "false") r[0].success = false;
          if (fault === "changes") r[0].results[0].changed = 2;
          if (fault === "results") delete r[0].results;
          if (fault === "hole") delete r[0];
          if (fault === "returnHole") delete r[0].results[0];
          if (fault === "zeroWithWrite") r[0].results = [];
          if (fault === "inflatedAggregate") r[0].meta.changes = 99;
          if (fault === "duplicate") r[1].results.push(r[1].results[0]);
        }
        return r;
      },
    };
    assert.deepEqual(await enqueue(wrapped, input, options), { status: "unavailable" });
    assert.equal(calls, 2);
    assert.equal((await jobs(db)).length, 1);
  }
  assert.equal((await rate(db))[0].calls, 9);
}

export async function uncertainRateNeverQueuesOrRefunds(db) {
  await seed(db);
  const wrapped = {
    batch: (s) => db.batch(s),
    prepare: (sql) => {
      if (!sql.startsWith("INSERT INTO rate")) return db.prepare(sql);
      return {
        bind: (...args) => ({
          run: async () => {
            await db
              .prepare(sql)
              .bind(...args)
              .run();
            return { success: true, meta: {}, results: [] };
          },
        }),
      };
    },
  };
  assert.deepEqual(await enqueue(wrapped, input, options), { status: "unavailable" });
  assert.deepEqual(await jobs(db), []);
  assert.equal((await rate(db))[0].calls, 1);
}

export async function malformedClockAcknowledgementsNeverSpend(db) {
  for (const fault of ["false", "hole", "empty", "rowArray", "badDate"]) {
    const wrapped = {
      prepare: (s) => db.prepare(s),
      batch: async (s) => {
        const r = await db.batch(s);
        if (fault === "false") r[0].success = false;
        if (fault === "hole") delete r[0];
        if (fault === "empty") r[0].results = [];
        if (fault === "rowArray") r[0].results[0] = Object.assign([], r[0].results[0]);
        if (fault === "badDate") r[0].results[0].day = "2026-02-30";
        return r;
      },
    };
    assert.deepEqual(await enqueue(wrapped, input, options), { status: "unavailable" });
  }
  assert.deepEqual(await rate(db), []);
  assert.deepEqual(await jobs(db), []);
}
