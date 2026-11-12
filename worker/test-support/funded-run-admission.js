import assert from "node:assert/strict";
import { reserveFirstFundedRun as reserve } from "../src/funded-run-admission.js";
import { cleanup } from "../src/limits.js";
const userHash = "a".repeat(64);
const input = (runId = "first") => ({
  userHash,
  task: "autofill",
  runId,
  allowance: 1,
  maxCalls: 3,
  estimate: 6,
  accountCeiling: 100,
  monthBudget: 100,
  dayBudget: 100,
  freeTier: true,
});
const tables = [
  "funded_run_calls",
  "funded_runs",
  "runs",
  "usage",
  "bonus",
  "budget",
  "spend",
  "forget",
];
const rows = (db, t) =>
  db
    .prepare(`SELECT * FROM ${t}`)
    .all()
    .then((r) => r.results);
const snapshot = (db) => Promise.all(tables.map((t) => rows(db, t)));
async function reset(db) {
  await db.batch([
    db.prepare("DROP TRIGGER IF EXISTS fixture_funded_abort"),
    ...tables.map((t) => db.prepare(`DELETE FROM ${t}`)),
  ]);
}
export async function fundedFirstConcurrentCapsAndConservation(db) {
  await reset(db);
  await db.prepare("INSERT INTO bonus VALUES(?,'autofill',1,0)").bind(userHash).run();
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => reserve(db, input(`run-${i}`))),
  );
  assert.equal(results.filter((r) => r.status === "reserved").length, 2);
  assert.deepEqual((await rows(db, "funded_runs")).map((r) => r.funding).sort(), [
    "invite",
    "monthly",
  ]);
  assert.equal((await rows(db, "usage"))[0].units, 2);
  assert.equal((await rows(db, "bonus"))[0].used, 1);
  assert.equal((await rows(db, "budget"))[0].spend_cents, 12);
  assert.deepEqual(
    (await rows(db, "spend")).map((r) => r.cents),
    [12, 12, 12],
  );
  const calls = await rows(db, "funded_run_calls");
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every(
      (c) =>
        c.state === "reserved" && c.estimate === 6 && c.account_metered === 1 && c.free_month === 1,
    ),
  );
  assert.ok((await rows(db, "runs")).every((r) => r.calls === 1));
  assert.equal((await rows(db, "funded_runs")).filter((r) => r.first_autofill_due === 1).length, 1);
  const before = await snapshot(db);
  assert.deepEqual(await reserve(db, input("run-0")), { status: "pending" });
  assert.deepEqual(await snapshot(db), before);
  await reset(db);
  const same = await Promise.all([reserve(db, input()), reserve(db, input())]);
  assert.equal(same.filter((r) => r.status === "reserved").length, 1);
  assert.equal((await rows(db, "usage"))[0].units, 1);
}
export async function fundedFirstBudgetAndDisabledBoundaries(db) {
  for (const field of ["accountCeiling", "monthBudget", "dayBudget"]) {
    await reset(db);
    const opts = { ...input(), allowance: 10, [field]: 6 };
    const r = await Promise.all([reserve(db, opts), reserve(db, { ...opts, runId: "next" })]);
    assert.equal(r.filter((v) => v.status === "reserved").length, 1);
    assert.equal((await rows(db, "budget"))[0].spend_cents, 6);
  }
  for (const patch of [
    { allowance: 0 },
    { maxCalls: 0 },
    { accountCeiling: 0 },
    { monthBudget: 0 },
    { dayBudget: 0 },
    { estimate: -1 },
  ]) {
    await reset(db);
    await db.prepare("INSERT INTO bonus VALUES(?,'autofill',5,0)").bind(userHash).run();
    const before = await snapshot(db);
    assert.deepEqual(await reserve(db, { ...input(), ...patch }), { status: "pending" });
    assert.deepEqual(await snapshot(db), before);
  }
  await reset(db);
  // Preserve existing one-estimate crossing: compare current spend before reservation.
  assert.equal((await reserve(db, { ...input(), dayBudget: 1 })).status, "reserved");
  assert.equal((await rows(db, "spend")).find((r) => r.month.length === 10).cents, 6);
}
export async function fundedFirstPaidUnlimitedAndLegacy(db) {
  await reset(db);
  const opts = { ...input(), allowance: null, accountCeiling: null, freeTier: false, dayBudget: 0 };
  await db
    .prepare("INSERT INTO spend VALUES('*',?,999)")
    .bind(new Date().toISOString().slice(0, 7))
    .run();
  assert.equal((await reserve(db, opts)).status, "reserved");
  assert.equal((await rows(db, "spend")).length, 1);
  assert.equal((await rows(db, "spend"))[0].cents, 999);
  const [call] = await rows(db, "funded_run_calls");
  assert.equal(call.account_metered, 0);
  assert.equal(call.free_day, null);
  assert.equal(call.free_month, 0);
  await reset(db);
  await db
    .prepare("INSERT INTO runs VALUES(?,?,'autofill','legacy',2)")
    .bind(userHash, new Date().toISOString().slice(0, 7))
    .run();
  const before = await snapshot(db);
  assert.deepEqual(await reserve(db, input("legacy")), { status: "pending" });
  assert.deepEqual(await snapshot(db), before);
}
export async function fundedFirstRollbackAmbiguityAndDeletion(db) {
  await reset(db);
  await db
    .prepare(
      "CREATE TRIGGER fixture_funded_abort BEFORE INSERT ON budget BEGIN SELECT RAISE(ABORT,'fixture_rollback'); END",
    )
    .run();
  assert.deepEqual(await reserve(db, input()), { status: "pending" });
  assert.ok((await snapshot(db)).every((r) => r.length === 0));
  await db.prepare("DROP TRIGGER fixture_funded_abort").run();
  // Lost transaction acknowledgment must not permit a second first charge or return authorization.
  const uncertain = {
    prepare: (sql) => db.prepare(sql),
    batch: async (stmts) => {
      await db.batch(stmts);
      return [{ success: false }];
    },
  };
  assert.deepEqual(await reserve(uncertain, input()), { status: "pending" });
  const before = await snapshot(db);
  assert.deepEqual(await reserve(db, input()), { status: "pending" });
  assert.deepEqual(await snapshot(db), before);
  await db
    .prepare("INSERT INTO forget VALUES(?,?)")
    .bind(userHash, new Date().toISOString().slice(0, 7))
    .run();
  assert.deepEqual(await reserve(db, { ...input("after-delete"), allowance: null }), {
    status: "pending",
  });
  assert.equal((await rows(db, "runs")).length, 1);
}
export async function fundedFirstUtcAndSweepCascade(db) {
  await reset(db);
  assert.deepEqual(await reserve(db, input(), new Date("2000-01-01T00:00:00Z")), {
    status: "pending",
  });
  assert.deepEqual(await reserve(db, input(), new Date("2099-01-01T00:00:00Z")), {
    status: "pending",
  });
  assert.ok((await snapshot(db)).every((r) => r.length === 0));
  const now = new Date();
  assert.equal((await reserve(db, input(), now)).status, "reserved");
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2));
  await cleanup(db, next);
  for (const table of ["runs", "funded_runs", "funded_run_calls", "spend"])
    assert.deepEqual(await rows(db, table), []);
}
