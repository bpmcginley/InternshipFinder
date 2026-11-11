// Same synthetic scenarios in SQLite and actual local D1; no provider calls.
import assert from "node:assert/strict";
import { recordVerifiedTopup } from "../src/topup-ledger.js";
import { readTopupRevision, reconcileExistingTopup } from "../src/topup-reconciliation.js";
import {
  allocatePurchasedRun as allocate,
  restorePurchasedRun as restore,
} from "../src/topup-allocation.js";

const USER = "a".repeat(64);
const balance = (db, hash) =>
  db
    .prepare("SELECT available,held,consumed,revoked FROM topup_purchases WHERE payment_hash=?")
    .bind(hash)
    .first();
async function purchase(db, id, units = 1, day = "11", userHash = USER) {
  return (
    await recordVerifiedTopup(
      db,
      {
        paymentId: `pi_${id}`,
        checkoutId: `cs_${id}`,
        userHash,
        livemode: false,
        offerVersion: "fixture-v1",
        amount: 300,
        currency: "usd",
        units,
      },
      new Date(`2026-11-${day}T12:00:00Z`),
    )
  ).purchase.payment_hash;
}
async function run(db, runId) {
  const value = { userHash: USER, month: "2026-11", task: "autofill", runId };
  await db
    .prepare("INSERT OR IGNORE INTO runs(user_hash,month,task,run_id,calls) VALUES (?,?,?,?,0)")
    .bind(value.userHash, value.month, value.task, value.runId)
    .run();
  return value;
}
async function reconcile(db, hash, status) {
  const row = await readTopupRevision(db, hash);
  return reconcileExistingTopup(db, hash, row.revision, {
    paymentId: row.payment_id,
    checkoutId: row.checkout_id,
    capturedAmount: row.amount,
    currency: row.currency,
    refundsComplete: true,
    disputesComplete: true,
    refunds:
      status === "refund"
        ? [
            {
              id: "refund-fixture",
              status: "succeeded",
              amount: row.amount,
              currency: row.currency,
            },
          ]
        : [],
    disputes:
      status === "refund"
        ? []
        : [{ id: "hold-fixture", status, amount: 1, currency: row.currency }],
  });
}

export async function allocationLifecycle(db) {
  const old = await purchase(db, "old", 2, "10"),
    newer = await purchase(db, "new", 2, "11");
  const other = await purchase(db, "other", 3, "09", "b".repeat(64));
  const a = await run(db, "a"),
    b = await run(db, "b"),
    c = await run(db, "c");
  for (const [identity, expected] of [
    [a, old],
    [b, old],
    [c, newer],
  ]) {
    const result = await allocate(db, identity);
    assert.equal(result.changed, true);
    assert.equal(result.allocation.payment_hash, expected);
  }
  assert.equal((await allocate(db, a)).changed, false);
  assert.deepEqual(await balance(db, old), { available: 0, held: 0, consumed: 2, revoked: 0 });
  assert.deepEqual(await balance(db, other), { available: 3, held: 0, consumed: 0, revoked: 0 });
  assert.equal((await restore(db, a)).changed, true);
  assert.equal((await restore(db, a)).changed, false);
  // Existing limits can delete/recreate this public run ID after failure. Until an internal
  // attempt fence is integrated, an old restored receipt must NOT authorize a new debit/run.
  await db.prepare("DELETE FROM runs WHERE run_id='a'").run();
  await run(db, "a");
  assert.deepEqual(await allocate(db, a), {
    changed: false,
    allocation: { payment_hash: old, state: "restored" },
  });
  assert.deepEqual(await balance(db, old), { available: 1, held: 0, consumed: 1, revoked: 0 });
  await db.prepare("DELETE FROM runs").run(); // Model monthly cleanup; receipt retention is separate.
  assert.equal((await restore(db, b)).changed, true);
  assert.deepEqual(await balance(db, old), { available: 2, held: 0, consumed: 0, revoked: 0 });
  assert.equal((await allocate(db, { ...a, runId: "missing" })).allocation, null);
  assert.equal((await allocate(db, { ...a, task: "rank" })).allocation, null);
  for (const patch of [{ month: "2026-13" }, { runId: "bad/run" }, { userHash: null }]) {
    assert.deepEqual(await allocate(db, { ...a, ...patch }), { changed: false, allocation: null });
    assert.deepEqual(await restore(db, { ...a, ...patch }), { changed: false, allocation: null });
  }
  await reconcile(db, old, "under_review");
  const d = await run(db, "d");
  assert.equal((await allocate(db, d)).allocation.payment_hash, newer);
  await restore(db, d);
  await reconcile(db, newer, "refund");
  assert.equal((await restore(db, c)).allocation.state, "revoked");
  assert.deepEqual(await balance(db, newer), { available: 0, held: 0, consumed: 0, revoked: 2 });
  assert.deepEqual(await balance(db, old), { available: 0, held: 2, consumed: 0, revoked: 0 });
  assert.equal((await allocate(db, await run(db, "blocked"))).allocation, null);
}

export async function allocationCurrentState(db) {
  const held = await purchase(db, "held"),
    a = await run(db, "hold-run");
  await allocate(db, a);
  await reconcile(db, held, "under_review"); // All units consumed; only governing IDs indicate hold.
  assert.equal((await restore(db, a)).allocation.state, "restored");
  assert.deepEqual(await balance(db, held), { available: 0, held: 1, consumed: 0, revoked: 0 });
  await reconcile(db, held, "won");
  assert.deepEqual(await balance(db, held), { available: 1, held: 0, consumed: 0, revoked: 0 });
  // Retire that unused fixture so each following run selects its own purchase.
  await reconcile(db, held, "refund");
  for (const terminal of ["lost", "refund", "retired"]) {
    const hash = await purchase(db, terminal),
      identity = await run(db, terminal);
    await allocate(db, identity);
    if (terminal === "retired")
      await db
        .prepare("UPDATE topup_claims SET state='retired' WHERE payment_hash=?")
        .bind(hash)
        .run();
    else await reconcile(db, hash, terminal);
    assert.equal((await restore(db, identity)).allocation.state, "revoked");
    assert.equal((await restore(db, identity)).changed, false);
    assert.deepEqual(await balance(db, hash), { available: 0, held: 0, consumed: 0, revoked: 1 });
  }
}

export async function allocationRacesAndRollback(db) {
  const hash = await purchase(db, "race"),
    a = await run(db, "race-run");
  const duplicates = await Promise.all(Array.from({ length: 8 }, () => allocate(db, a)));
  assert.equal(duplicates.filter((r) => r.changed).length, 1);
  const returns = await Promise.all(Array.from({ length: 8 }, () => restore(db, a)));
  assert.equal(returns.filter((r) => r.changed).length, 1);
  const b = await run(db, "contender-b"),
    c = await run(db, "contender-c");
  const contenders = await Promise.all([allocate(db, b), allocate(db, c)]);
  assert.equal(contenders.filter((r) => r.changed).length, 1);
  const winner = contenders[0].changed ? b : c;
  await Promise.all([restore(db, winner), reconcile(db, hash, "refund")]);
  assert.deepEqual(await balance(db, hash), { available: 0, held: 0, consumed: 0, revoked: 1 });
  const failed = await purchase(db, "rollback"),
    d = await run(db, "rollback-run");
  await db
    .prepare(
      "CREATE TRIGGER fail_allocation BEFORE UPDATE ON topup_purchases BEGIN SELECT RAISE(ABORT,'fixture rollback'); END",
    )
    .run();
  await assert.rejects(allocate(db, d), /fixture rollback/);
  assert.equal(
    await db
      .prepare("SELECT COUNT(*) AS n FROM topup_allocations WHERE run_id='rollback-run'")
      .first("n"),
    0,
  );
  await db.prepare("DROP TRIGGER fail_allocation").run();
  await allocate(db, d);
  await db
    .prepare(
      "CREATE TRIGGER fail_restoration BEFORE UPDATE ON topup_purchases BEGIN SELECT RAISE(ABORT,'fixture rollback'); END",
    )
    .run();
  await assert.rejects(restore(db, d), /fixture rollback/);
  assert.equal((await allocate(db, d)).allocation.state, "allocated");
  await db.prepare("DROP TRIGGER fail_restoration").run();
  await db.prepare("DELETE FROM topup_purchases WHERE payment_hash=?").bind(failed).run();
  assert.deepEqual(await restore(db, d), { changed: false, allocation: null });
  assert.equal(
    await db
      .prepare("SELECT COUNT(*) AS n FROM topup_claims WHERE payment_hash=?")
      .bind(failed)
      .first("n"),
    1,
  );
  const deleted = await purchase(db, "deleteRace"),
    e = await run(db, "delete-race");
  await allocate(db, e);
  await Promise.all([
    restore(db, e),
    db.prepare("DELETE FROM topup_purchases WHERE payment_hash=?").bind(deleted).run(),
  ]);
  assert.equal(await balance(db, deleted), null);
  assert.deepEqual(await restore(db, e), { changed: false, allocation: null });
}
