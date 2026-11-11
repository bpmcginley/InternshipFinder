import assert from "node:assert/strict";
import { reserveFirstFundedRun } from "../src/funded-run-admission.js";
import {
  acceptFundedCall as accept,
  releaseFundedCall as release,
  meterFundedCall as meter,
} from "../src/funded-run-callbacks.js";
import { cleanup, deleteUser } from "../src/limits.js";
const userHash = "a".repeat(64),
  task = "autofill";
const tables = [
  "funded_run_calls",
  "funded_runs",
  "runs",
  "usage",
  "bonus",
  "budget",
  "spend",
  "forget",
  "tokens",
  "task_tokens",
  "event_counts",
];
const rows = (db, t) =>
  db
    .prepare(`SELECT * FROM ${t}`)
    .all()
    .then((r) => r.results);
const snapshot = (db) => Promise.all(tables.map((t) => rows(db, t)));
const opts = (runId = "same") => ({
  userHash,
  task,
  runId,
  allowance: 2,
  maxCalls: 4,
  estimate: 6,
  accountCeiling: 100,
  monthBudget: 100,
  dayBudget: 100,
  freeTier: true,
});
const accounting = {
  cents: 2,
  usage: {
    promptTokenCount: 10,
    cachedContentTokenCount: 2,
    candidatesTokenCount: 3,
    thoughtsTokenCount: 4,
  },
  model: "synthetic-model",
};
async function setup(db, patch = {}) {
  await db.batch([
    db.prepare("DROP TRIGGER IF EXISTS fixture_callback_abort"),
    ...tables.map((t) => db.prepare(`DELETE FROM ${t}`)),
  ]);
  const input = { ...opts(), ...patch };
  const admitted = await reserveFirstFundedRun(db, input);
  assert.equal(admitted.status, "reserved");
  return { ...input, ...admitted };
}
async function sibling(db, id) {
  const callId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        "INSERT INTO funded_run_calls SELECT ?,generation,'reserved',9,account_metered,free_day,free_month FROM funded_run_calls WHERE call_id=?",
      )
      .bind(callId, id.callId),
    db
      .prepare("UPDATE runs SET calls=calls+1 WHERE user_hash=? AND month=? AND run_id=?")
      .bind(userHash, id.month, id.runId),
    db.prepare("UPDATE budget SET spend_cents=spend_cents+9 WHERE month=?").bind(id.month),
    db.prepare("UPDATE spend SET cents=cents+9"),
  ]);
  return { ...id, callId };
}
export async function fundedCallbacksSiblingOrdersAndDuplicates(db) {
  for (const acceptFirst of [false, true]) {
    const a = await setup(db),
      b = await sibling(db, a),
      accepted = acceptFirst ? a : b,
      released = acceptFirst ? b : a;
    if (acceptFirst) assert.deepEqual(await accept(db, accepted), { status: "accepted" });
    assert.deepEqual(
      await release(db, { ...released, estimate: 999, freeTier: false, accountCeiling: null }),
      { status: "released" },
    );
    assert.equal((await rows(db, "usage"))[0].units, 1);
    assert.equal((await rows(db, "runs"))[0].calls, 1);
    if (!acceptFirst) assert.deepEqual(await accept(db, accepted), { status: "accepted" });
    const before = await snapshot(db);
    assert.deepEqual(await release(db, released), { status: "inactive" });
    assert.deepEqual(await release(db, accepted), { status: "inactive" });
    assert.deepEqual(await accept(db, accepted), { status: "inactive" });
    assert.deepEqual(await snapshot(db), before);
    const result = await Promise.all([
      meter(db, accepted, accounting),
      meter(db, accepted, accounting),
    ]);
    assert.deepEqual(result.map((r) => r.status).sort(), ["inactive", "metered"]);
    assert.equal((await rows(db, "budget"))[0].spend_cents, 2);
    assert.ok((await rows(db, "spend")).every((r) => r.cents === 2));
    assert.deepEqual((await rows(db, "tokens"))[0], {
      month: a.month,
      calls: 1,
      prompt: 10,
      cached: 2,
      output: 7,
    });
    assert.equal((await rows(db, "task_tokens"))[0].cents, 2);
    assert.equal((await rows(db, "event_counts"))[0].n, 1);
    assert.deepEqual(await rows(db, "funded_run_calls"), []);
  }
}
export async function fundedCallbacksConcurrentSiblings(db) {
  let a = await setup(db),
    b = await sibling(db, a);
  assert.deepEqual(
    (await Promise.all([accept(db, a), accept(db, b)])).map((r) => r.status),
    ["accepted", "accepted"],
  );
  assert.equal((await rows(db, "event_counts"))[0].n, 1);
  await Promise.all([meter(db, a, accounting), meter(db, b, accounting)]);
  assert.equal((await rows(db, "usage"))[0].units, 1);
  assert.equal((await rows(db, "budget"))[0].spend_cents, 4);
  assert.equal((await rows(db, "tokens"))[0].calls, 2);
  assert.equal((await rows(db, "runs"))[0].calls, 2);
  a = await setup(db);
  b = await sibling(db, a);
  assert.deepEqual(
    (await Promise.all([release(db, a), release(db, b)])).map((r) => r.status),
    ["released", "released"],
  );
  assert.equal((await rows(db, "usage"))[0].units, 0);
  assert.equal((await rows(db, "budget"))[0].spend_cents, 0);
  assert.deepEqual(await rows(db, "runs"), []);
}

export async function fundedCallbacksLastFailureAndReplacement(db) {
  for (const invite of [false, true]) {
    let a = await setup(db);
    if (invite) {
      // Fill the monthly allowance with a committed legacy run, then admit an invite-funded generation.
      await release(db, a);
      await db.prepare("UPDATE usage SET units=2").run();
      await db.prepare("INSERT INTO bonus VALUES(?,'autofill',1,0)").bind(userHash).run();
      a = { ...opts(), ...(await reserveFirstFundedRun(db, opts())) };
      assert.equal(a.status, "reserved");
    }
    const b = await sibling(db, a);
    assert.deepEqual(await release(db, a), { status: "released" });
    assert.equal((await rows(db, "budget"))[0].spend_cents, 9);
    assert.equal((await rows(db, "usage"))[0].units, invite ? 3 : 1);
    assert.deepEqual(await release(db, b), { status: "released" });
    assert.equal((await rows(db, "usage"))[0].units, invite ? 2 : 0);
    if (invite) assert.equal((await rows(db, "bonus"))[0].used, 0);
    assert.equal((await rows(db, "budget"))[0].spend_cents, 0);
    assert.deepEqual(await rows(db, "runs"), []);
    const next = { ...opts(), ...(await reserveFirstFundedRun(db, opts())) };
    assert.equal(next.status, "reserved");
    assert.notEqual(next.generation, a.generation);
    const before = await snapshot(db);
    for (const stale of [
      a,
      b,
      { ...next, generation: a.generation },
      { ...next, runId: "wrong" },
    ]) {
      assert.deepEqual(await release(db, stale), { status: "inactive" });
      assert.deepEqual(await accept(db, stale), { status: "inactive" });
    }
    assert.deepEqual(await snapshot(db), before);
  }
}
export async function fundedCallbacksConcurrentAcceptRelease(db) {
  for (const acceptFirst of [false, true]) {
    const a = await setup(db);
    const jobs = acceptFirst ? [accept(db, a), release(db, a)] : [release(db, a), accept(db, a)];
    const result = await Promise.all(jobs);
    assert.equal(result.filter((r) => r.status === "inactive").length, 1);
    const accepted = result.some((r) => r.status === "accepted");
    assert.equal((await rows(db, "usage"))[0].units, Number(accepted));
    assert.equal((await rows(db, "budget"))[0].spend_cents, accepted ? 6 : 0);
    assert.equal((await rows(db, "event_counts")).length, Number(accepted));
  }
}
export async function fundedCallbacksRollbackAndUnknownCommit(db) {
  for (const action of ["accept", "release", "meter"]) {
    const a = await setup(db);
    if (action === "meter") await accept(db, a);
    const trigger =
      action === "accept"
        ? "BEFORE UPDATE ON funded_run_calls"
        : action === "release"
          ? "BEFORE DELETE ON runs"
          : "BEFORE DELETE ON funded_run_calls";
    await db
      .prepare(
        `CREATE TRIGGER fixture_callback_abort ${trigger} BEGIN SELECT RAISE(ABORT,'fixture_rollback'); END`,
      )
      .run();
    const before = await snapshot(db),
      callback = action === "accept" ? accept : action === "release" ? release : meter;
    assert.deepEqual(await callback(db, a, accounting), { status: "pending" });
    assert.deepEqual(await snapshot(db), before);
    await db.prepare("DROP TRIGGER fixture_callback_abort").run();
    const lost = {
      prepare: (sql) => db.prepare(sql),
      batch: async (list) => {
        await db.batch(list);
        throw Error("synthetic lost acknowledgment");
      },
    };
    assert.deepEqual(await callback(lost, a, accounting), { status: "pending" });
    const committed = await snapshot(db);
    assert.deepEqual(await callback(db, a, accounting), { status: "inactive" });
    assert.deepEqual(await snapshot(db), committed);
    if (action === "accept") assert.deepEqual(await release(db, a), { status: "inactive" });
  }
}
export async function fundedCallbacksSignedDeltaPaidAndFloors(db) {
  const a = await setup(db);
  await reserveFirstFundedRun(db, opts("other"));
  await accept(db, a);
  await meter(db, a, accounting);
  assert.equal((await rows(db, "budget"))[0].spend_cents, 8);
  assert.ok((await rows(db, "spend")).every((r) => r.cents === 8));
  const paid = await setup(db, { freeTier: false, accountCeiling: null });
  await accept(db, paid);
  assert.deepEqual(await meter(db, paid, { ...accounting, cents: 9 }), { status: "metered" });
  assert.equal((await rows(db, "budget"))[0].spend_cents, 9);
  assert.deepEqual(await rows(db, "spend"), []);
  const floor = await setup(db);
  await accept(db, floor);
  await db.batch([
    db.prepare("UPDATE budget SET spend_cents=0"),
    db.prepare("UPDATE spend SET cents=0"),
  ]);
  await meter(db, floor, accounting);
  assert.equal((await rows(db, "budget"))[0].spend_cents, 0);
  assert.ok((await rows(db, "spend")).every((r) => r.cents === 0));
}
export async function fundedCallbacksDeletionSweepAndInvalidMeter(db) {
  for (const swept of [false, true]) {
    const a = await setup(db),
      now = new Date();
    if (swept)
      await cleanup(db, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2)));
    else await deleteUser(db, userHash, now);
    const before = await snapshot(db);
    for (const callback of [accept, release, meter])
      assert.deepEqual(await callback(db, a, accounting), { status: "inactive" });
    assert.deepEqual(await snapshot(db), before);
  }
  const a = await setup(db);
  await accept(db, a);
  const before = await snapshot(db);
  for (const patch of [
    { cents: NaN },
    { cents: -1 },
    { usage: { promptTokenCount: Infinity } },
    { usage: false },
    { usage: "invalid" },
    { model: "contains private spaces" },
  ])
    assert.deepEqual(await meter(db, a, { ...accounting, ...patch }), { status: "pending" });
  assert.deepEqual(await snapshot(db), before);
}
