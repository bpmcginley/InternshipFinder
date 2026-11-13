import assert from "node:assert/strict";
import {
  captureTopupCoverage as capture,
  rotateTopupCoverage as rotate,
  closeTopupCoverage as close,
} from "../src/topup-history-coverage.js";
import { deleteUser } from "../src/limits.js";
const on = { enabled: true };
const input = (expected = null, livemode = false, schemaKey = "synthetic-v1") => ({
  livemode,
  schemaKey,
  expected,
});
const rows = async (db) =>
  (await db.prepare("SELECT * FROM topup_history_coverage ORDER BY mode").all()).results;
const start = async (db, live = false) => {
  const r = await rotate(db, input(null, live), on);
  assert.equal(r.status, "committed");
  return r.coverage;
};

export async function disabledAndInvalidHaveNoDatabaseAccess() {
  let calls = 0;
  const db = {
    prepare() {
      calls++;
      throw new Error();
    },
  };
  for (const enabled of [undefined, false, "true", 1, null]) {
    assert.equal((await capture(db, false, { enabled })).status, "disabled");
    assert.equal((await rotate(db, input(), { enabled })).status, "disabled");
    assert.equal((await close(db, null, { enabled })).status, "disabled");
  }
  for (const v of [
    input(null, "false"),
    input(null, false, ""),
    input(null, false, "x".repeat(65)),
    { ...input(), health: "qualified" },
    input({}),
  ])
    assert.equal((await rotate(db, v, on)).status, "unavailable");
  assert.equal(
    (
      await rotate(
        db,
        {
          ...input(),
          get schemaKey() {
            throw new Error("private");
          },
        },
        on,
      )
    ).status,
    "unavailable",
  );
  assert.equal(calls, 0);
}
export async function initialEpochAndRotationStayUnproven(db) {
  assert.equal((await capture(db, false, on)).status, "missing");
  const a = await start(db),
    b = await start(db, true);
  assert.deepEqual(await capture(db, false, on), { status: "captured", coverage: a });
  assert.equal(a.health, "unproven");
  assert.equal(a.covered_through, null);
  assert.equal(a.revision, 1);
  const next = await rotate(db, input(a, false, "synthetic-v2"), on);
  assert.equal(next.status, "committed");
  assert.equal(next.coverage.revision, 2);
  assert.notEqual(next.coverage.epoch, a.epoch);
  assert.ok(next.coverage.starts_at >= a.starts_at);
  assert.equal(next.coverage.health, "unproven");
  assert.equal(next.coverage.covered_through, null);
  assert.deepEqual((await capture(db, true, on)).coverage, b);
  assert.equal((await close(db, a, on)).status, "stale");
  assert.equal((await rotate(db, input(a), on)).status, "stale");
  assert.equal((await rotate(db, input(), on)).status, "stale");
}
export async function concurrentCreationAndCasHaveOneWinner(db) {
  const created = await Promise.all([rotate(db, input(), on), rotate(db, input(), on)]);
  assert.deepEqual(created.map((r) => r.status).sort(), ["committed", "stale"]);
  const a = created.find((r) => r.status === "committed").coverage;
  const raced = await Promise.all([close(db, a, on), rotate(db, input(a), on)]);
  assert.deepEqual(raced.map((r) => r.status).sort(), ["committed", "stale"]);
  assert.equal((await rows(db)).length, 1);
  assert.equal((await capture(db, false, on)).coverage.revision, 2);
  assert.equal((await close(db, a, on)).status, "stale");
}
export async function closurePreservesBoundsAndCannotCompleteCoverage(db) {
  await start(db);
  // Synthetic future replay package state only. No production API can perform this transition.
  await db
    .prepare(
      "UPDATE topup_history_coverage SET starts_at='2020-01-01T00:00:00.000Z',covered_through='2020-01-02T00:00:00.000Z',health='qualified'",
    )
    .run();
  const a = (await capture(db, false, on)).coverage;
  const closed = await close(db, a, on);
  assert.equal(closed.status, "committed");
  assert.deepEqual(closed.coverage, { ...a, revision: a.revision + 1, health: "closed" });
  const next = await rotate(db, input(closed.coverage), on);
  assert.equal(next.coverage.health, "unproven");
  assert.equal(next.coverage.covered_through, null);
  assert.equal(next.coverage.revision, 3);
}
export async function everyCapturedFieldFencesMutation(db) {
  const a = await start(db);
  for (const patch of [
    { epoch: "0".repeat(32) },
    { schema_key: "other" },
    { starts_at: "2020-01-01T00:00:00.000Z" },
    { revision: 2 },
    { health: "closed" },
  ]) {
    assert.equal((await close(db, { ...a, ...patch }, on)).status, "stale");
    assert.equal((await rotate(db, input({ ...a, ...patch }), on)).status, "stale");
  }
  assert.equal((await rotate(db, input(a, true), on)).status, "unavailable");
  assert.deepEqual((await capture(db, false, on)).coverage, a);
}
export async function databaseClockRollbackAndRevisionOverflowStayClosed(db) {
  const a = await start(db);
  await db.prepare("UPDATE topup_history_coverage SET starts_at='9999-01-01T00:00:00.000Z'").run();
  const future = (await rows(db))[0];
  assert.equal((await capture(db, false, on)).status, "unavailable");
  assert.equal((await close(db, future, on)).status, "stale");
  assert.equal((await rotate(db, input(future), on)).status, "stale");
  await db
    .prepare("UPDATE topup_history_coverage SET starts_at=?,revision=?")
    .bind(a.starts_at, Number.MAX_SAFE_INTEGER)
    .run();
  const full = (await capture(db, false, on)).coverage;
  assert.equal((await close(db, full, on)).status, "unavailable");
  assert.equal((await rotate(db, input(full), on)).status, "unavailable");
  assert.equal((await rows(db))[0].revision, Number.MAX_SAFE_INTEGER);
}
export async function failedBatchRollsBackExactly(db) {
  const a = await start(db);
  await db
    .prepare(
      "CREATE TRIGGER history_coverage_fail AFTER UPDATE ON topup_history_coverage BEGIN SELECT RAISE(ABORT,'fixture rollback'); END",
    )
    .run();
  try {
    assert.equal((await close(db, a, on)).status, "unavailable");
    assert.equal((await rotate(db, input(a), on)).status, "unavailable");
    assert.deepEqual((await capture(db, false, on)).coverage, a);
  } finally {
    await db.prepare("DROP TRIGGER history_coverage_fail").run();
  }
  assert.equal((await close(db, a, on)).status, "committed");
}
export async function committedUnknownAcknowledgementsDoNotRetry(db) {
  for (const fault of ["throw", "false", "sparse", "row", "health"]) {
    await db.prepare("DELETE FROM topup_history_coverage").run();
    let calls = 0;
    const uncertain = {
      prepare: db.prepare.bind(db),
      async batch(statements) {
        calls++;
        const r = await db.batch(statements);
        if (fault === "throw") throw new Error("private");
        if (fault === "false") r[0].success = false;
        if (fault === "sparse") delete r[0];
        if (fault === "row") r[1].results = [null];
        if (fault === "health") r[1].results[0].health = "closed";
        return r;
      },
    };
    assert.equal((await rotate(uncertain, input(), on)).status, "unavailable");
    assert.equal(calls, 1);
    assert.equal((await rows(db))[0].revision, 1);
    assert.equal((await rotate(db, input(), on)).status, "stale");
  }
}
export async function accountDeletionDoesNotRetainAnyAccountAssociation(db) {
  const a = await start(db);
  await deleteUser(db, "a".repeat(64));
  assert.deepEqual((await capture(db, false, on)).coverage, a);
  assert.deepEqual(
    Object.keys((await rows(db))[0]).sort(),
    ["mode", "epoch", "schema_key", "starts_at", "covered_through", "revision", "health"].sort(),
  );
}

export async function changedCoverageCutoffFencesOldSnapshots(db) {
  await start(db);
  await db
    .prepare(
      "UPDATE topup_history_coverage SET starts_at='2020-01-01T00:00:00.000Z',covered_through='2020-01-02T00:00:00.000Z',health='qualified'",
    )
    .run();
  const before = (await capture(db, false, on)).coverage;
  await db
    .prepare("UPDATE topup_history_coverage SET covered_through='2020-01-03T00:00:00.000Z'")
    .run();
  assert.equal((await close(db, before, on)).status, "stale");
  assert.equal((await rotate(db, input(before), on)).status, "stale");
  assert.equal((await rows(db))[0].revision, before.revision);
  await db
    .prepare("UPDATE topup_history_coverage SET covered_through='9999-01-01T00:00:00.000Z'")
    .run();
  const future = (await rows(db))[0];
  assert.equal((await capture(db, false, on)).status, "unavailable");
  assert.equal((await close(db, future, on)).status, "stale");
  assert.equal((await rotate(db, input(future), on)).status, "stale");
}

export async function lostClosureAcknowledgementCommitsOnlyOnce(db) {
  const before = await start(db);
  let calls = 0;
  const uncertain = {
    prepare: db.prepare.bind(db),
    async batch(statements) {
      calls++;
      await db.batch(statements);
      throw new Error("lost acknowledgement");
    },
  };
  assert.equal((await close(uncertain, before, on)).status, "unavailable");
  assert.equal(calls, 1);
  const current = (await capture(db, false, on)).coverage;
  assert.deepEqual(current, { ...before, revision: 2, health: "closed" });
  assert.equal((await close(db, before, on)).status, "stale");
  assert.deepEqual((await capture(db, false, on)).coverage, current);
}
