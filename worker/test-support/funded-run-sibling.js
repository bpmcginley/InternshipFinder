import assert from "node:assert/strict";
import { reserveFirstFundedRun as first } from "../src/funded-run-admission.js";
import { reserveFundedSibling as sibling } from "../src/funded-run-sibling.js";
import {
  acceptFundedCall as accept,
  releaseFundedCall as release,
  meterFundedCall as meter,
} from "../src/funded-run-callbacks.js";
import { CONFIG } from "../src/config.js";
import {
  allowanceFor,
  userBudgetCents,
  budgetCents,
  dailyBudgetCents,
  admit,
  deleteUser,
  cleanup,
} from "../src/limits.js";
const userHash = "a".repeat(64),
  task = "autofill",
  runId = "synthetic-run";
const config = {
  ...CONFIG,
  TASKS: { ...CONFIG.TASKS, autofill: { ...CONFIG.TASKS.autofill, allowance: 1 } },
  ALLOWANCE_CHANGES: [],
  MAX_CALLS_PER_RUN: 3,
  USER_BUDGET_CENTS: { free: 100, supporter: 100 },
  MONTHLY_BUDGET_CENTS: 100,
  DAILY_BUDGET_CENTS: 100,
};
const input = (plan = "free", now = new Date()) => ({
  userHash,
  task,
  runId,
  allowance: allowanceFor(config, {}, task, "edu", plan, now),
  maxCalls: config.MAX_CALLS_PER_RUN,
  estimate: 6,
  accountCeiling: userBudgetCents(config, {}, "edu", plan),
  monthBudget: budgetCents({}, config),
  dayBudget: dailyBudgetCents({}, config),
  freeTier: plan === "free",
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
  "rate",
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
async function reset(db, invite = false) {
  await db.batch([
    db.prepare("DROP TRIGGER IF EXISTS fixture_sibling_abort"),
    ...tables.map((t) => db.prepare(`DELETE FROM ${t}`)),
  ]);
  if (invite)
    await db.batch([
      db
        .prepare("INSERT INTO usage VALUES(?,?,'autofill',1)")
        .bind(userHash, new Date().toISOString().slice(0, 7)),
      db.prepare("INSERT INTO bonus VALUES(?,'autofill',1,0)").bind(userHash),
    ]);
}
async function setup(db, invite = false, patch = {}) {
  await reset(db, invite);
  const opts = { ...input(), ...patch },
    result = await first(db, opts);
  assert.equal(result.status, "reserved");
  return { ...opts, ...result };
}
const totals = async (db) => ({
  calls: (await rows(db, "runs"))[0]?.calls || 0,
  units: (await rows(db, "usage"))[0]?.units || 0,
  bonus: (await rows(db, "bonus"))[0]?.used || 0,
  budget: (await rows(db, "budget"))[0]?.spend_cents || 0,
  spend: (await rows(db, "spend")).map((r) => [r.user_hash, r.month, r.cents]).sort(),
});
export async function fundedSiblingMatchesExistingAccounting(db) {
  for (const invite of [false, true]) {
    await reset(db, invite);
    const now = new Date();
    await admit(db, {}, config, userHash, task, runId, now, "edu", "free", 6);
    await admit(db, {}, config, userHash, task, runId, now, "edu", "free", 6);
    const legacy = await totals(db);
    const a = await setup(db, invite),
      b = await sibling(db, a);
    assert.equal(b.status, "reserved");
    assert.deepEqual(await totals(db), legacy);
    assert.deepEqual(await release(db, a), { status: "released" });
    assert.deepEqual(await release(db, { ...a, ...b }), { status: "released" });
    assert.equal((await totals(db)).units, invite ? 1 : 0);
    assert.equal((await totals(db)).bonus, 0);
    assert.equal((await totals(db)).budget, 0);
  }
}
export async function fundedSiblingConcurrentCapAndSlotRelease(db) {
  const a = await setup(db),
    options = { ...a, estimate: 9 };
  const results = await Promise.all(Array.from({ length: 8 }, () => sibling(db, options)));
  const admitted = results.filter((r) => r.status === "reserved");
  assert.equal(admitted.length, 2);
  assert.equal((await totals(db)).calls, 3);
  assert.equal((await totals(db)).units, 1);
  assert.equal((await totals(db)).budget, 24);
  for (const r of admitted)
    assert.deepEqual(await release(db, { ...options, ...r }), { status: "released" });
  assert.equal((await totals(db)).budget, 6);
  assert.equal((await totals(db)).calls, 1);
  const next = await sibling(db, options);
  assert.equal(next.status, "reserved");
  assert.notEqual(next.callId, admitted[0].callId);
  assert.deepEqual(await release(db, { ...options, ...next }), { status: "released" });
  await release(db, a);
  assert.equal((await totals(db)).units, 0);
}
export async function fundedSiblingAcceptedReplayAndPaidBuckets(db) {
  const original = await setup(db),
    joined = { ...original, ...(await sibling(db, { ...original, estimate: 9 })) };
  assert.equal(joined.status, "reserved");
  assert.deepEqual(await accept(db, joined), { status: "accepted" });
  await release(db, original);
  await meter(db, joined, { cents: 3 });
  assert.equal((await totals(db)).budget, 3);
  assert.equal((await totals(db)).units, 1);
  const acceptedBefore = await snapshot(db);
  assert.deepEqual(await accept(db, joined), { status: "inactive" });
  assert.deepEqual(await meter(db, joined, { cents: 999 }), { status: "inactive" });
  assert.deepEqual(await snapshot(db), acceptedBefore);
  const a = await setup(db);
  await accept(db, a);
  await meter(db, a, { cents: 2 });
  const b = await sibling(db, {
    ...a,
    estimate: 9,
    freeTier: false,
    accountCeiling: null,
    dayBudget: 0,
  });
  assert.equal(b.status, "reserved");
  assert.equal((await totals(db)).budget, 11);
  assert.ok((await rows(db, "spend")).every((r) => r.cents === 2));
  const before = await snapshot(db);
  assert.deepEqual(await accept(db, a), { status: "inactive" });
  assert.deepEqual(await meter(db, a, { cents: 999 }), { status: "inactive" });
  assert.deepEqual(await snapshot(db), before);
  assert.deepEqual(await release(db, { ...a, ...b }), { status: "released" });
  assert.equal((await totals(db)).budget, 2);
  assert.equal((await totals(db)).units, 1);
  assert.equal((await totals(db)).calls, 1);
  assert.equal((await rows(db, "event_counts"))[0].n, 1);
}
export async function fundedSiblingRacesLastFailureAndReplacement(db) {
  for (const reserveFirst of [false, true]) {
    const a = await setup(db);
    const jobs = reserveFirst
      ? [sibling(db, { ...a, estimate: 9 }), release(db, a)]
      : [release(db, a), sibling(db, { ...a, estimate: 9 })];
    const result = await Promise.all(jobs);
    assert.ok(result.some((r) => r.status === "released"));
    const joined = result.find((r) => r.status === "reserved");
    assert.equal((await totals(db)).units, joined ? 1 : 0);
    assert.equal((await totals(db)).budget, joined ? 9 : 0);
    if (joined) await release(db, { ...a, ...joined });
    const next = await first(db, input());
    assert.equal(next.status, "reserved");
    assert.notEqual(next.generation, a.generation);
    const before = await snapshot(db);
    assert.deepEqual(await sibling(db, a), { status: "pending" });
    assert.deepEqual(await snapshot(db), before);
  }
}
export async function fundedSiblingBudgetDisabledLegacyAndUtc(db) {
  for (const field of ["accountCeiling", "monthBudget", "dayBudget"]) {
    const a = await setup(db),
      opts = { ...a, maxCalls: 10, estimate: 9, [field]: 7 };
    const r = await Promise.all([sibling(db, opts), sibling(db, opts)]);
    assert.equal(r.filter((x) => x.status === "reserved").length, 1);
    assert.equal((await totals(db)).budget, 15);
  }
  for (const patch of [
    { allowance: 0 },
    { maxCalls: 1 },
    { monthBudget: 0 },
    { accountCeiling: 0 },
    { dayBudget: 0 },
    { generation: crypto.randomUUID() },
    { month: "2000-01" },
  ]) {
    const a = await setup(db),
      before = await snapshot(db);
    assert.deepEqual(await sibling(db, { ...a, ...patch }), { status: "pending" });
    assert.deepEqual(await snapshot(db), before);
  }
  for (const invalid of ["legacy", "deleted", "swept"]) {
    const a = await setup(db);
    if (invalid === "legacy") await db.prepare("DELETE FROM funded_runs").run();
    else if (invalid === "deleted") await deleteUser(db, userHash, new Date());
    else {
      const now = new Date();
      await cleanup(db, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2)));
    }
    const before = await snapshot(db);
    assert.deepEqual(await sibling(db, a), { status: "pending" });
    assert.deepEqual(await snapshot(db), before);
  }
}
export async function fundedSiblingRollbackAndUnknownCommit(db) {
  const a = await setup(db, false, { maxCalls: 2 });
  await db
    .prepare(
      "CREATE TRIGGER fixture_sibling_abort BEFORE INSERT ON budget BEGIN SELECT RAISE(ABORT,'fixture_rollback'); END",
    )
    .run();
  const before = await snapshot(db);
  assert.deepEqual(await sibling(db, a), { status: "pending" });
  assert.deepEqual(await snapshot(db), before);
  await db.prepare("DROP TRIGGER fixture_sibling_abort").run();
  const unknown = {
    prepare: (sql) => db.prepare(sql),
    batch: async (list) => {
      await db.batch(list);
      return [{ success: false }];
    },
  };
  assert.deepEqual(await sibling(unknown, a), { status: "pending" });
  const committed = await snapshot(db);
  assert.equal((await totals(db)).calls, 2);
  assert.equal((await totals(db)).units, 1);
  assert.deepEqual(await sibling(db, a), { status: "pending" });
  assert.deepEqual(await snapshot(db), committed);
}
