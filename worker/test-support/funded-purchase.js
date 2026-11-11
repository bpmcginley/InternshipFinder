import assert from "node:assert/strict";
import { reserveFirstFundedRun as first } from "../src/funded-run-admission.js";
import { reserveFundedSibling as sibling } from "../src/funded-run-sibling.js";
import {
  acceptFundedCall as accept,
  releaseFundedCall as release,
  meterFundedCall as meter,
} from "../src/funded-run-callbacks.js";
import { recordVerifiedTopup } from "../src/topup-ledger.js";
import { readTopupRevision, reconcileExistingTopup } from "../src/topup-reconciliation.js";
import { deleteUser, cleanup } from "../src/limits.js";
const userHash = "a".repeat(64);
const options = (runId = "fixture") => ({
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
  allowPurchased: true,
});
const rows = async (db, t) => (await db.prepare(`SELECT * FROM ${t}`).all()).results;
const balances = async (db, hash) =>
  db
    .prepare("SELECT available,held,consumed,revoked FROM topup_purchases WHERE payment_hash=?")
    .bind(hash)
    .first();
async function purchase(db, id = "fixture", units = 1, created = "2026-11-10", who = userHash) {
  return (
    await recordVerifiedTopup(
      db,
      {
        paymentId: `pi_${id}`,
        checkoutId: `cs_${id}`,
        userHash: who,
        livemode: false,
        offerVersion: "fixture-v1",
        amount: 300,
        currency: "usd",
        units,
      },
      new Date(created + "T12:00:00Z"),
    )
  ).purchase.payment_hash;
}
async function exhausted(db) {
  await db
    .prepare("INSERT INTO usage VALUES(?,?,'autofill',1)")
    .bind(userHash, new Date().toISOString().slice(0, 7))
    .run();
}
async function funded(db, runId = "fixture") {
  const input = options(runId),
    result = await first(db, input);
  assert.equal(result.status, "reserved");
  return { ...input, ...result };
}
async function reconcile(db, hash, status) {
  const p = await readTopupRevision(db, hash);
  return reconcileExistingTopup(db, hash, p.revision, {
    paymentId: p.payment_id,
    checkoutId: p.checkout_id,
    capturedAmount: p.amount,
    currency: p.currency,
    refundsComplete: true,
    disputesComplete: true,
    refunds:
      status === "refund"
        ? [{ id: "refund-fixture", status: "succeeded", amount: p.amount, currency: p.currency }]
        : [],
    disputes:
      status === "refund"
        ? []
        : [{ id: "dispute-fixture", status, amount: 1, currency: p.currency }],
  });
}
export async function purchaseFundingIsExplicitAndOrdered(db) {
  const old = await purchase(db, "old"),
    newer = await purchase(db, "new", 1, "2026-11-11"),
    other = await purchase(db, "other", 1, "2026-11-09", "b".repeat(64));
  await db.prepare("INSERT INTO bonus VALUES(?,'autofill',1,0)").bind(userHash).run();
  await funded(db, "monthly");
  await funded(db, "invite");
  assert.deepEqual(
    (await rows(db, "funded_runs")).map((r) => r.funding),
    ["monthly", "invite"],
  );
  assert.deepEqual(await first(db, { ...options("off"), allowPurchased: false }), {
    status: "pending",
  });
  assert.deepEqual(await first(db, { ...options("disabled"), allowance: 0 }), {
    status: "pending",
  });
  await funded(db, "old");
  await funded(db, "new");
  assert.deepEqual(
    (await rows(db, "topup_generation_allocations")).map((r) => r.payment_hash),
    [old, newer],
  );
  assert.deepEqual(await balances(db, other), { available: 1, held: 0, consumed: 0, revoked: 0 });
  assert.equal((await rows(db, "bonus"))[0].used, 1);
}
export async function purchaseGenerationRestoresOnceAndReusesPublicId(db) {
  const hash = await purchase(db);
  await exhausted(db);
  const a = await funded(db),
    b = { ...a, ...(await sibling(db, a)) };
  assert.equal(b.status, "reserved");
  await Promise.all([release(db, a), release(db, b)]);
  assert.deepEqual(await balances(db, hash), { available: 1, held: 0, consumed: 0, revoked: 0 });
  const next = await funded(db);
  assert.notEqual(next.generation, a.generation);
  assert.equal((await rows(db, "topup_generation_allocations")).length, 2);
  assert.deepEqual(await release(db, a), { status: "inactive" });
  await accept(db, next);
  await meter(db, next, { cents: 2 });
  assert.deepEqual(await balances(db, hash), { available: 0, held: 0, consumed: 1, revoked: 0 });
}
export async function purchaseLastUnitConcurrentAdmission(db) {
  const hash = await purchase(db);
  await exhausted(db);
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => first(db, options(`run-${i}`))),
  );
  assert.equal(results.filter((r) => r.status === "reserved").length, 1);
  assert.equal((await rows(db, "runs")).length, 1);
  assert.equal((await rows(db, "topup_generation_allocations")).length, 1);
  assert.deepEqual(await balances(db, hash), { available: 0, held: 0, consumed: 1, revoked: 0 });
}
export async function purchaseReversalAndReleaseAreConservative(db) {
  await exhausted(db);
  for (const [status, destination] of [
    ["needs_response", "held"],
    ["lost", "revoked"],
    ["refund", "revoked"],
  ]) {
    for (const reverseFirst of [false, true]) {
      const id = status + reverseFirst,
        hash = await purchase(db, id),
        a = await funded(db, id);
      const operations = [() => reconcile(db, hash, status), () => release(db, a)];
      if (!reverseFirst) operations.reverse();
      await operations[0]();
      await operations[1]();
      const expected = { available: 0, held: 0, consumed: 0, revoked: 0 };
      expected[destination] = 1;
      assert.deepEqual(await balances(db, hash), expected);
      assert.deepEqual(await release(db, a), { status: "inactive" });
    }
  }
}
export async function purchaseReversalRacesAndAcceptedSiblingConserve(db) {
  await exhausted(db);
  for (const status of ["needs_response", "lost", "refund"]) {
    const hash = await purchase(db, status),
      a = await funded(db, status);
    await Promise.all([release(db, a), reconcile(db, hash, status)]);
    const value = await balances(db, hash);
    assert.equal(value.available, 0);
    assert.equal(value.consumed, 0);
    assert.equal(value.held, status === "needs_response" ? 1 : 0);
    assert.equal(value.revoked, status === "needs_response" ? 0 : 1);
  }
  const hash = await purchase(db, "acceptedrace"),
    a = await funded(db, "accepted-race"),
    b = { ...a, ...(await sibling(db, a)) };
  await Promise.all([release(db, a), accept(db, b)]);
  assert.deepEqual(await balances(db, hash), { available: 0, held: 0, consumed: 1, revoked: 0 });
  await meter(db, b, { cents: 2 });
  assert.equal(
    (await rows(db, "topup_generation_allocations")).find((r) => r.generation === a.generation)
      .state,
    "allocated",
  );
}
export async function purchaseHeldZeroBlocksUnacceptedSiblingsButNotAccepted(db) {
  const hash = await purchase(db, "hold", 2);
  await exhausted(db);
  const a = await funded(db, "accepted"),
    b = await funded(db, "unaccepted");
  await accept(db, a);
  await reconcile(db, hash, "needs_response");
  assert.equal((await balances(db, hash)).held, 0);
  assert.deepEqual(await sibling(db, b), { status: "pending" });
  assert.equal((await sibling(db, a)).status, "reserved");
  await release(db, b);
  assert.deepEqual(await balances(db, hash), { available: 0, held: 1, consumed: 1, revoked: 0 });
  await reconcile(db, hash, "won");
  assert.equal((await balances(db, hash)).available, 1);
  const c = await funded(db, "refund-in-flight");
  await reconcile(db, hash, "refund");
  assert.deepEqual(await sibling(db, c), { status: "pending" });
  assert.deepEqual(await accept(db, c), { status: "accepted" });
  assert.equal((await sibling(db, c)).status, "reserved");
  assert.equal((await balances(db, hash)).consumed, 2);
}
export async function purchaseAdmissionAndRestorationRollback(db) {
  const hash = await purchase(db);
  await exhausted(db);
  await db
    .prepare(
      "CREATE TRIGGER fixture_purchase_abort BEFORE INSERT ON budget BEGIN SELECT RAISE(ABORT,'fixture'); END",
    )
    .run();
  assert.deepEqual(await first(db, options()), { status: "pending" });
  assert.equal((await rows(db, "runs")).length, 0);
  assert.equal((await rows(db, "topup_generation_allocations")).length, 0);
  assert.equal((await balances(db, hash)).available, 1);
  await db.prepare("DROP TRIGGER fixture_purchase_abort").run();
  const a = await funded(db);
  await db
    .prepare(
      "CREATE TRIGGER fixture_restore_abort BEFORE DELETE ON runs BEGIN SELECT RAISE(ABORT,'fixture'); END",
    )
    .run();
  assert.deepEqual(await release(db, a), { status: "pending" });
  assert.equal((await balances(db, hash)).consumed, 1);
  assert.equal((await rows(db, "topup_generation_allocations"))[0].state, "allocated");
  await db.prepare("DROP TRIGGER fixture_restore_abort").run();
  await release(db, a);
  const uncertain = {
    prepare: db.prepare.bind(db),
    batch: async (q) => {
      await db.batch(q);
      throw Error("fixture lost acknowledgment");
    },
  };
  assert.deepEqual(await first(uncertain, options()), { status: "pending" });
  assert.deepEqual(await first(db, options()), { status: "pending" });
  assert.equal((await balances(db, hash)).consumed, 1);
}
export async function purchaseReceiptsSurviveRunSweepButRespectDeletion(db) {
  const hash = await purchase(db);
  await exhausted(db);
  const a = await funded(db);
  const nextMonth = new Date();
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  await cleanup(db, nextMonth);
  assert.equal((await rows(db, "funded_run_calls")).length, 0);
  assert.equal((await rows(db, "topup_generation_allocations")).length, 1);
  assert.deepEqual(await release(db, a), { status: "inactive" });
  assert.equal((await balances(db, hash)).consumed, 1);
  await deleteUser(db, userHash);
  assert.equal((await rows(db, "topup_generation_allocations")).length, 0);
  assert.equal((await rows(db, "topup_claims"))[0].state, "deleted");
  assert.deepEqual(await accept(db, a), { status: "inactive" });
}
