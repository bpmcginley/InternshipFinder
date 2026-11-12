// Identical synthetic lifecycle/race proof runs in Node SQLite and actual local D1.
import assert from "node:assert/strict";
import { recordVerifiedTopup } from "../src/topup-ledger.js";
import { readTopupRevision, reconcileExistingTopup } from "../src/topup-reconciliation.js";

const snapshot = (patch = {}) => ({
  capturedAmount: 325,
  currency: "usd",
  refundsComplete: true,
  disputesComplete: true,
  refunds: [],
  disputes: [],
  ...patch,
});
const dispute = (id, status = "under_review") => ({ id, status, amount: 1, currency: "usd" });
const refunded = () =>
  snapshot({
    refunds: [{ id: "refund-fixture", status: "succeeded", amount: 325, currency: "usd" }],
  });
const balance = (db, key) =>
  db
    .prepare("SELECT available,held,consumed,revoked FROM topup_purchases WHERE payment_hash=?")
    .bind(key)
    .first();
async function purchase(db, id) {
  return (
    await recordVerifiedTopup(
      db,
      {
        paymentId: `pi_${id}`,
        checkoutId: `cs_${id}`,
        userHash: "a".repeat(64),
        livemode: false,
        offerVersion: "fixture-v1",
        amount: 325,
        currency: "usd",
        units: 25,
      },
      new Date("2026-11-11T12:00:00Z"),
    )
  ).purchase.payment_hash;
}
// Synthetic provider fixtures carry immutable identity; this is not a live verification adapter.
async function reconcile(db, key, revision, data) {
  const row = await readTopupRevision(db, key);
  return reconcileExistingTopup(db, key, revision, {
    paymentId: row?.payment_id,
    checkoutId: row?.checkout_id,
    ...data,
  });
}
const intercept = (db, before) => ({
  prepare: (sql) => db.prepare(sql),
  batch: async (statements) => {
    await before();
    return db.batch(statements);
  },
});
const paired = (db) => {
  let arrived = 0,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return intercept(db, async () => {
    if (++arrived === 2) release();
    await gate;
  });
};

export async function reconciliationLifecycle(db) {
  const key = await purchase(db, "lifecycle"),
    other = await purchase(db, "isolated");
  assert.equal((await readTopupRevision(db, key)).revision, 0);
  const otherRefs = await readTopupRevision(db, other);
  for (const refs of [
    { paymentId: otherRefs.payment_id },
    { checkoutId: otherRefs.checkout_id },
    { paymentId: undefined },
    { checkoutId: undefined },
  ]) {
    assert.equal((await reconcile(db, key, 0, snapshot(refs))).status, "retry");
  }
  assert.equal((await reconcile(db, "f".repeat(64), 0, snapshot())).status, "unavailable");
  assert.equal((await reconcile(db, key, -1, snapshot())).status, "stale");

  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM topup_reconciliations").first("n"), 0);
  assert.deepEqual(await reconcile(db, key, 0, snapshot({ refundsComplete: false })), {
    status: "retry",
  });
  assert.deepEqual(await reconcile(db, key, 0, snapshot({ capturedAmount: 300 })), {
    status: "retry",
  });
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM topup_reconciliations").first("n"), 0);
  // Consumption changes after the read, before CAS: only the current unused 20 move.
  const changed = intercept(db, () =>
    db
      .prepare("UPDATE topup_purchases SET available=20,consumed=5 WHERE payment_hash=?")
      .bind(key)
      .run(),
  );
  assert.equal(
    (await reconcile(changed, key, 0, snapshot({ disputes: [dispute("hold-a")] }))).status,
    "applied",
  );
  assert.deepEqual(await balance(db, key), { available: 0, held: 20, consumed: 5, revoked: 0 });
  assert.deepEqual((await readTopupRevision(db, key)).previous.heldDisputeIds, ["hold-a"]);
  assert.equal(
    (await reconcile(db, key, 1, snapshot({ disputes: [dispute("unrelated", "won")] }))).status,
    "retry",
  );
  const won = snapshot({ disputes: [dispute("hold-a", "won")] });
  assert.equal((await reconcile(db, key, 1, won)).status, "applied");
  assert.deepEqual(await balance(db, key), { available: 20, held: 0, consumed: 5, revoked: 0 });
  assert.equal((await reconcile(db, key, 2, refunded())).status, "applied");
  assert.deepEqual(await balance(db, key), { available: 0, held: 0, consumed: 5, revoked: 20 });
  assert.equal((await reconcile(db, key, 2, won)).status, "stale");
  // A caller cannot override committed terminal facts with a fabricated previous state.
  assert.equal(
    (await reconcile(db, key, 3, { ...won, previous: { fullRefund: false } })).decision.disposition,
    "revoked",
  );
  assert.deepEqual(await balance(db, key), { available: 0, held: 0, consumed: 5, revoked: 20 });
  assert.deepEqual(await balance(db, other), { available: 25, held: 0, consumed: 0, revoked: 0 });
  const orphan = await purchase(db, "orphan");
  await db
    .prepare("UPDATE topup_purchases SET available=0,held=25 WHERE payment_hash=?")
    .bind(orphan)
    .run();
  assert.equal((await reconcile(db, orphan, 0, snapshot())).status, "retry");
  assert.equal((await readTopupRevision(db, orphan)).revision, 0);
  const restored = await purchase(db, "restored");
  await db
    .prepare("UPDATE topup_purchases SET available=20,consumed=5 WHERE payment_hash=?")
    .bind(restored)
    .run();
  // Raw fixture only: no failed-run restoration API is shipped here.
  const returned = intercept(db, () =>
    db
      .prepare("UPDATE topup_purchases SET available=21,consumed=4 WHERE payment_hash=?")
      .bind(restored)
      .run(),
  );
  await reconcile(returned, restored, 0, snapshot({ disputes: [dispute("return-hold")] }));
  assert.deepEqual(await balance(db, restored), {
    available: 0,
    held: 21,
    consumed: 4,
    revoked: 0,
  });
  const zero = await purchase(db, "zero");
  await db
    .prepare("UPDATE topup_purchases SET available=0,consumed=25 WHERE payment_hash=?")
    .bind(zero)
    .run();
  await reconcile(db, zero, 0, snapshot({ disputes: [dispute("zero-hold")] }));
  assert.equal((await readTopupRevision(db, zero)).previous.held, true);
  assert.deepEqual(await balance(db, zero), { available: 0, held: 0, consumed: 25, revoked: 0 });
  await reconcile(db, zero, 1, snapshot({ disputes: [dispute("zero-hold", "lost")] }));
  const appeal = await reconcile(
    db,
    zero,
    2,
    snapshot({ disputes: [dispute("zero-hold", "won")] }),
  );
  assert.equal(appeal.decision.manualReview, true);
  assert.equal(appeal.decision.disposition, "revoked");
}

export async function reconciliationRaces(db) {
  const key = await purchase(db, "race"),
    race = paired(db);
  const attempts = await Promise.all(
    ["hold-a", "hold-b"].map((id) =>
      reconcile(race, key, 0, snapshot({ disputes: [dispute(id)] })),
    ),
  );
  assert.equal(attempts.filter((r) => r.status === "applied").length, 1);
  assert.equal(attempts.filter((r) => r.status === "stale").length, 1);
  const stored = await readTopupRevision(db, key),
    winner = attempts.find((r) => r.status === "applied");
  assert.equal(stored.revision, 1);
  assert.deepEqual(stored.previous.heldDisputeIds, winner.decision.heldDisputeIds);
  const won = snapshot({ disputes: [dispute(stored.previous.heldDisputeIds[0], "won")] });
  const next = paired(db);
  const outcomes = await Promise.all([
    reconcile(next, key, 1, won),
    reconcile(next, key, 1, refunded()),
  ]);
  assert.equal(outcomes.filter((r) => r.status === "applied").length, 1);
  assert.equal(outcomes.filter((r) => r.status === "stale").length, 1);
  const mode = outcomes.find((r) => r.status === "applied").decision.disposition;
  assert.deepEqual(await balance(db, key), {
    available: mode === "available" ? 25 : 0,
    held: 0,
    consumed: 0,
    revoked: mode === "revoked" ? 25 : 0,
  });
  assert.equal((await reconcile(db, key, 2, refunded())).status, "applied");
  assert.deepEqual(await balance(db, key), { available: 0, held: 0, consumed: 0, revoked: 25 });
}

export async function reconciliationRollbackAndDeletion(db) {
  const key = await purchase(db, "rollback");
  await db
    .prepare(
      "CREATE TRIGGER reject_reconcile BEFORE UPDATE ON topup_purchases BEGIN SELECT RAISE(ABORT,'fixture rollback'); END",
    )
    .run();
  await assert.rejects(reconcile(db, key, 0, refunded()), /fixture rollback/);
  assert.equal((await readTopupRevision(db, key)).revision, 0);
  assert.deepEqual(await balance(db, key), { available: 25, held: 0, consumed: 0, revoked: 0 });
  await db.prepare("DROP TRIGGER reject_reconcile").run();
  await reconcile(db, key, 0, refunded());
  // Raw fixture deletion models future wiring; it is not an implemented account-delete API.
  const deleted = intercept(db, () =>
    db.batch([
      db.prepare("DELETE FROM topup_purchases WHERE payment_hash=?").bind(key),
      db.prepare("UPDATE topup_claims SET state='deleted' WHERE payment_hash=?").bind(key),
    ]),
  );
  assert.equal((await reconcile(deleted, key, 1, snapshot())).status, "stale");
  assert.equal(await readTopupRevision(db, key), null);
  assert.equal(
    await db
      .prepare("SELECT COUNT(*) AS n FROM topup_reconciliations WHERE payment_hash=?")
      .bind(key)
      .first("n"),
    0,
  );
  assert.equal((await reconcile(db, key, 0, snapshot())).status, "unavailable");
  assert.equal(
    await db
      .prepare("SELECT state FROM topup_claims WHERE payment_hash=?")
      .bind(key)
      .first("state"),
    "deleted",
  );
  const terminal = await purchase(db, "terminal");
  const retired = intercept(db, () =>
    db.prepare("UPDATE topup_claims SET state='retired' WHERE payment_hash=?").bind(terminal).run(),
  );
  assert.equal((await reconcile(retired, terminal, 0, refunded())).status, "stale");
  assert.equal(await readTopupRevision(db, terminal), null);
  assert.deepEqual(await balance(db, terminal), {
    available: 25,
    held: 0,
    consumed: 0,
    revoked: 0,
  });
}
