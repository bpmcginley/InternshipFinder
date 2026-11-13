import assert from "node:assert/strict";
import {
  cleanupFollowSendBudget as cleanup,
  reserveFollowSendAttempt as reserve,
} from "../src/follow-send-budget.js";

const day = new Date("2026-11-10T00:00:00.000Z");
const after = (ms) => new Date(+day + ms);
const row = (db) => db.prepare("SELECT * FROM follow_send_budget WHERE slot=1").first();

export async function aggregateConcurrency(db) {
  const results = await Promise.all(Array.from({ length: 12 }, () => reserve(db, 5, day)));
  assert.equal(results.filter(Boolean).length, 5);
  assert.deepEqual(await row(db), { slot: 1, observed_at: day.toISOString(), attempts: 5 });
  assert.equal(await reserve(db, 2, after(1)), false);
  assert.equal(await reserve(db, 6, day), false); // Earlier than even the denied request.
  assert.equal(await reserve(db, 6, after(1)), true);
  assert.equal(await reserve(db, 6, after(1)), false);
  assert.equal((await row(db)).attempts, 6);
}

export async function aggregateRollover(db) {
  const last = after(86_399_999),
    next = after(86_400_000);
  assert.equal(await reserve(db, 1, last), true);
  assert.equal(await cleanup(db, last), true);
  assert.equal(await reserve(db, 1, last), false);
  assert.equal(await cleanup(db, next), true);
  assert.equal(await cleanup(db, last), false);
  assert.equal(await reserve(db, 10, last), false);
  assert.deepEqual(await row(db), { slot: 1, observed_at: next.toISOString(), attempts: 0 });
  assert.equal(await reserve(db, 1, next), true);
  assert.equal(await cleanup(db, next), true);
  assert.equal(await reserve(db, 1, next), false);
  const tomorrow = after(2 * 86_400_000);
  assert.equal(await reserve(db, 1, tomorrow), true); // No cron dependency for logical rollover.
  assert.deepEqual(await row(db), { slot: 1, observed_at: tomorrow.toISOString(), attempts: 1 });
}

export async function aggregateBoundsAndRollback(db) {
  for (const cap of [undefined, 0, -1, "1", 1.1, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(await reserve(db, cap, day), false);
  assert.equal(await reserve(db, 1, new Date(NaN)), false);
  assert.equal(await cleanup(db, new Date("+010000-01-01T00:00:00.000Z")), false);
  assert.equal(await row(db), null);
  assert.equal(await reserve(db, 1, day), true);
  const next = after(86_400_000);
  await db
    .prepare(
      "CREATE TRIGGER synthetic_budget_failure BEFORE UPDATE OF attempts ON follow_send_budget " +
        "WHEN NEW.attempts=1 AND OLD.attempts=0 BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END",
    )
    .run();
  try {
    assert.equal(await reserve(db, 1, next), false);
    assert.deepEqual(await row(db), { slot: 1, observed_at: day.toISOString(), attempts: 1 });
  } finally {
    await db.prepare("DROP TRIGGER synthetic_budget_failure").run();
  }
  const lost = {
    prepare: (sql) => db.prepare(sql),
    async batch(statements) {
      await db.batch(statements);
      throw new Error("synthetic response loss after commit");
    },
  };
  assert.equal(await reserve(lost, 1, next), false);
  assert.equal(await reserve(db, 1, next), false);
  assert.equal((await row(db)).attempts, 1);

  await db
    .prepare("UPDATE follow_send_budget SET attempts=? WHERE slot=1")
    .bind(Number.MAX_SAFE_INTEGER - 1)
    .run();
  assert.equal(await reserve(db, Number.MAX_SAFE_INTEGER, next), true);
  assert.equal(await reserve(db, Number.MAX_SAFE_INTEGER, next), false);
  assert.equal((await row(db)).attempts, Number.MAX_SAFE_INTEGER);
  const unavailable = {
    prepare() {
      throw new Error("synthetic database unavailable");
    },
  };
  assert.equal(await reserve(unavailable, 1, next), false);
  assert.equal(await cleanup(unavailable, next), false);
}
