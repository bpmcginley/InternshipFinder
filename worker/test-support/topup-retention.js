// Shared synthetic evidence runs unchanged on SQLite and actual local D1.
import assert from "node:assert/strict";
import { recordVerifiedTopup } from "../src/topup-ledger.js";
import { readTopupRevision, reconcileExistingTopup } from "../src/topup-reconciliation.js";
import { topupFinanciallyResolved, invalidateTopupRetention } from "../src/topup-retention.js";
import { allocatePurchasedRun, restorePurchasedRun } from "../src/topup-allocation.js";
import { reserveFirstFundedRun } from "../src/funded-run-admission.js";
import { releaseFundedCall } from "../src/funded-run-callbacks.js";
import { deleteUser } from "../src/limits.js";
const user = "a".repeat(64),
  old = "2020-01-01T00:00:00.000Z";
const item = (status) => ({ id: "fixture", status, amount: 300, currency: "usd" });
const snapshot = (patch = {}) => ({
  capturedAmount: 300,
  currency: "usd",
  refundsComplete: true,
  disputesComplete: true,
  refunds: [],
  disputes: [],
  ...patch,
});
const state = (db, key) =>
  db
    .prepare("SELECT resolved_at,resolved_zero_since FROM topup_retention WHERE payment_hash=?")
    .bind(key)
    .first();
async function purchase(db, id = "fixture", units = 1) {
  return (
    await recordVerifiedTopup(
      db,
      {
        paymentId: `pi_${id}`,
        checkoutId: `cs_${id}`,
        userHash: user,
        livemode: false,
        offerVersion: "fixture",
        amount: 300,
        currency: "usd",
        units,
      },
      new Date(old),
    )
  ).purchase.payment_hash;
}
async function reconcile(db, key, patch = {}, revision) {
  const p = await readTopupRevision(db, key);
  return reconcileExistingTopup(db, key, revision ?? p.revision, {
    paymentId: p.payment_id,
    checkoutId: p.checkout_id,
    ...snapshot(patch),
  });
}
async function age(db, key) {
  await db
    .prepare(
      "UPDATE topup_retention SET resolved_at=?,resolved_zero_since=CASE WHEN resolved_zero_since IS NULL THEN NULL ELSE ? END WHERE payment_hash=?",
    )
    .bind(old, old, key)
    .run();
}
export async function retentionEvidenceValidation() {
  const yes = (s, p = { loss: false }) => topupFinanciallyResolved(snapshot(s), p);
  assert.equal(yes({}), true);
  for (const status of ["succeeded", "failed", "canceled"])
    assert.equal(yes({ refunds: [item(status)] }), true);
  for (const status of ["won", "warning_closed", "prevented", "lost"])
    assert.equal(yes({ disputes: [item(status)] }), true);
  for (const status of ["pending", "requires_action", "unknown"])
    assert.equal(yes({ refunds: [item(status)] }), false);
  for (const status of [
    "needs_response",
    "under_review",
    "appeal_needs_response",
    "appeal_under_review",
    "warning_needs_response",
    "warning_under_review",
    "unknown",
  ])
    assert.equal(yes({ disputes: [item(status)] }), false);
  for (const patch of [
    { refundsComplete: false },
    { disputesComplete: false },
    { refunds: null },
    { disputes: [{ ...item("won"), currency: "eur" }] },
    { refunds: [item("succeeded"), { ...item("failed") }] },
  ])
    assert.equal(yes(patch), false);
  assert.equal(yes({ disputes: [item("lost")] }, { loss: true }), false);
  assert.equal(yes({ disputes: [item("won")] }, { loss: true }), false);
  assert.equal(yes({ refundsComplete: false }, { loss: false, fullRefund: true }), false);
  assert.equal(
    yes({ refunds: [item("succeeded")] }, { loss: false, heldDisputeIds: ["fixture"] }),
    false,
  );
  assert.equal(
    yes(
      { refunds: [item("succeeded")], disputes: [item("won")] },
      { loss: false, heldDisputeIds: ["fixture"] },
    ),
    true,
  );
}
export async function retentionAnchorsAndRestoration(db) {
  const key = await purchase(db);
  assert.equal(await state(db, key), null); // old creation alone never starts a clock
  await reconcile(db, key);
  assert.equal((await state(db, key)).resolved_zero_since, null);
  const run = { userHash: user, month: "2026-11", task: "autofill", runId: "retention-first" };
  const addRun = (r) =>
    db
      .prepare("INSERT INTO runs(user_hash,month,task,run_id) VALUES(?,?,?,?)")
      .bind(r.userHash, r.month, r.task, r.runId)
      .run();
  await addRun(run);
  assert.equal((await allocatePurchasedRun(db, run)).changed, true);
  let saved = await state(db, key);
  assert.ok(saved.resolved_at > old);
  assert.ok(saved.resolved_zero_since >= saved.resolved_at);
  await age(db, key);
  await reconcile(db, key); // repeated clear evidence does not prolong retention
  assert.equal((await state(db, key)).resolved_zero_since, old);
  assert.equal((await restorePurchasedRun(db, run)).changed, true);
  assert.equal((await state(db, key)).resolved_zero_since, null);
  assert.equal((await restorePurchasedRun(db, run)).changed, false);
  const next = { ...run, runId: "retention-next" };
  await addRun(next);
  await allocatePurchasedRun(db, next);
  assert.ok((await state(db, key)).resolved_zero_since > old);
  await reconcile(db, key, { refunds: [item("pending")] });
  assert.deepEqual(await state(db, key), { resolved_at: null, resolved_zero_since: null });
  await reconcile(db, key, { refunds: [item("failed")] });
  assert.ok((await state(db, key)).resolved_zero_since > old);
  await age(db, key);
  await reconcile(db, key, { disputes: [item("warning_under_review")] });
  assert.equal((await state(db, key)).resolved_zero_since, null);
  await reconcile(db, key, { disputes: [item("warning_closed")] });
  assert.ok((await state(db, key)).resolved_zero_since > old);
  const rev = (await readTopupRevision(db, key)).revision;
  assert.equal((await reconcile(db, key, { refundsComplete: false })).status, "retry");
  assert.equal((await readTopupRevision(db, key)).revision, rev);
  assert.equal((await state(db, key)).resolved_at, null);
  await reconcile(db, key);
  saved = await state(db, key);
  await invalidateTopupRetention(db, key, rev); // stale invalidation cannot clear newer evidence
  assert.deepEqual(await state(db, key), saved);
}
export async function retentionTerminalAndUnknown(db) {
  const key = await purchase(db);
  await reconcile(db, key, { refunds: [item("succeeded")] });
  assert.ok((await state(db, key)).resolved_zero_since);
  // Committed full-refund policy can short-circuit; resolution validation must not.
  await reconcile(db, key, { refundsComplete: false });
  assert.equal((await state(db, key)).resolved_at, null);
  await reconcile(db, key, {
    refunds: [item("succeeded")],
    disputes: [item("appeal_under_review")],
  });
  assert.equal((await state(db, key)).resolved_at, null);
  await reconcile(db, key, { refunds: [item("succeeded")] });
  assert.ok((await state(db, key)).resolved_zero_since);
  const lost = await purchase(db, "loss");
  await reconcile(db, lost, { disputes: [item("lost")] });
  assert.ok((await state(db, lost)).resolved_zero_since);
  // No retained governing-loss identity: a later unrelated loss/win cannot prove resolution.
  await reconcile(db, lost, { disputes: [{ ...item("lost"), id: "unrelated" }] });
  assert.equal((await state(db, lost)).resolved_at, null);
  await reconcile(db, lost, { disputes: [item("won")] });
  assert.equal((await state(db, lost)).resolved_at, null);
}
export async function retentionRacesRollbackAndDeletion(db) {
  const key = await purchase(db);
  await db
    .prepare("UPDATE topup_purchases SET available=0,consumed=1 WHERE payment_hash=?")
    .bind(key)
    .run();
  let arrived = 0,
    release;
  const gate = new Promise((r) => {
    release = r;
  });
  const paired = {
    prepare: (s) => db.prepare(s),
    batch: async (ss) => {
      if (++arrived === 2) release();
      await gate;
      return db.batch(ss);
    },
  };
  const results = await Promise.all([
    reconcile(paired, key),
    reconcile(paired, key, { refunds: [item("pending")] }),
  ]);
  assert.equal(results.filter((r) => r.status === "applied").length, 1);
  const clearWon = results[0].status === "applied";
  assert.equal(!!(await state(db, key)).resolved_zero_since, clearWon);
  await reconcile(db, key);
  const saved = await state(db, key),
    rev = (await readTopupRevision(db, key)).revision;
  await db
    .prepare(
      "CREATE TRIGGER fixture_retention_failure BEFORE UPDATE ON topup_retention BEGIN SELECT RAISE(ABORT,'fixture_retention_failure'); END",
    )
    .run();
  await assert.rejects(
    () => reconcile(db, key, { disputes: [item("under_review")] }),
    /fixture_retention_failure/,
  );
  assert.equal((await readTopupRevision(db, key)).revision, rev);
  assert.deepEqual(await state(db, key), saved);
  await db.prepare("DROP TRIGGER fixture_retention_failure").run();
  await deleteUser(db, user);
  assert.equal(await state(db, key), null);
  assert.equal(
    await db
      .prepare("SELECT state FROM topup_claims WHERE payment_hash=?")
      .bind(key)
      .first("state"),
    "deleted",
  );
  await assert.rejects(
    () =>
      recordVerifiedTopup(db, {
        paymentId: "pi_fixture",
        checkoutId: "cs_fixture",
        userHash: user,
        livemode: false,
        offerVersion: "fixture",
        amount: 300,
        currency: "usd",
        units: 1,
      }),
    /unavailable/,
  );
}

export async function retentionFundedGeneration(db) {
  const key = await purchase(db);
  await reconcile(db, key);
  const month = new Date().toISOString().slice(0, 7);
  await db.prepare("INSERT INTO usage VALUES(?,?,'autofill',1)").bind(user, month).run();
  const input = {
    userHash: user,
    task: "autofill",
    runId: "retention-generation",
    allowance: 1,
    maxCalls: 3,
    estimate: 6,
    accountCeiling: 100,
    monthBudget: 100,
    dayBudget: 100,
    freeTier: true,
    allowPurchased: true,
  };
  const first = await reserveFirstFundedRun(db, input);
  assert.equal(first.status, "reserved");
  assert.ok((await state(db, key)).resolved_zero_since);
  assert.equal((await releaseFundedCall(db, { ...input, ...first })).status, "released");
  assert.equal((await state(db, key)).resolved_zero_since, null);
  const second = await reserveFirstFundedRun(db, input);
  assert.equal(second.status, "reserved");
  assert.ok((await state(db, key)).resolved_zero_since);
  await reconcile(db, key, { disputes: [item("under_review")] });
  assert.equal((await state(db, key)).resolved_at, null);
  assert.equal((await releaseFundedCall(db, { ...input, ...second })).status, "released");
  assert.equal((await state(db, key)).resolved_zero_since, null);
  assert.equal(
    await db
      .prepare("SELECT held FROM topup_purchases WHERE payment_hash=?")
      .bind(key)
      .first("held"),
    1,
  );
  await reconcile(db, key, { disputes: [item("won")] });
  const third = await reserveFirstFundedRun(db, input);
  assert.equal(third.status, "reserved");
  assert.ok((await state(db, key)).resolved_zero_since);
  assert.equal((await releaseFundedCall(db, { ...input, ...second })).status, "inactive");
  assert.ok((await state(db, key)).resolved_zero_since); // crossed old callback cannot reset it
}
