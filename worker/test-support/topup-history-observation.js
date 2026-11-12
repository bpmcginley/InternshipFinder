import assert from "node:assert/strict";
import {
  observeTopupHistory as observe,
  cleanupTopupHistoryReceipts as cleanup,
} from "../src/topup-history-observation.js";
import { captureTopupSettlement, settleFirstTopup } from "../src/topup-first-settlement.js";
import { readTopupRevision, reconcileExistingTopup } from "../src/topup-reconciliation.js";
import { retireResolvedTopup } from "../src/topup-retirement.js";
import { referenceHash } from "../src/topup-ledger.js";
import { deleteUser } from "../src/limits.js";
const on = { enabled: true };
const all = async (db, table) =>
  (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results;
async function fixture(db, live = false, id = crypto.randomUUID()) {
  const suffix = id.replaceAll("-", ""),
    user = suffix.repeat(2);
  await db
    .prepare(
      "INSERT INTO topup_checkout_attempts(id,user_hash,offer_version,amount,currency,units,created,state) VALUES(?,?,'fixture-v1',300,'usd',25,'2026-11-10T00:00:00.000Z','creating')",
    )
    .bind(id, user)
    .run();
  const capture = await captureTopupSettlement(db, id);
  const payment = {
    status: "paid_evidence",
    attemptId: id,
    userHash: user,
    offerVersion: "fixture-v1",
    offerAmount: 300,
    currency: "usd",
    units: 25,
    livemode: live,
    checkoutId: `cs_${suffix}`,
    paymentId: `pi_${suffix}`,
    chargeId: `ch_${suffix}`,
    capturedAmount: 327,
  };
  const reversals = {
    status: "reversal_evidence",
    paymentId: payment.paymentId,
    checkoutId: payment.checkoutId,
    chargeId: payment.chargeId,
    livemode: live,
    currency: "usd",
    capturedAmount: 327,
    refunds: [],
    disputes: [],
    refundsComplete: true,
    disputesComplete: true,
  };
  const observation = {
    eventId: `evt_${suffix}`,
    paymentId: payment.paymentId,
    checkoutId: payment.checkoutId,
    livemode: live,
    revision: 1,
  };
  return {
    capture,
    payment,
    reversals,
    observation,
    user,
    key: await referenceHash("payment", live, payment.paymentId),
  };
}
async function settled(db) {
  const f = await fixture(db);
  assert.equal((await settleFirstTopup(db, f.capture, f.payment, f.reversals)).status, "settled");
  await db
    .prepare("UPDATE topup_purchases SET available=0,consumed=25 WHERE payment_hash=?")
    .bind(f.key)
    .run();
  await db
    .prepare(
      "UPDATE topup_retention SET resolved_at='2020-01-01T00:00:00.000Z',resolved_zero_since='2020-01-01T00:00:00.000Z' WHERE payment_hash=?",
    )
    .bind(f.key)
    .run();
  return f;
}
export async function invalidAndDisabledNeverTouchStorage() {
  let calls = 0;
  const db = {
    prepare() {
      calls++;
      throw Error();
    },
    batch() {
      calls++;
      throw Error();
    },
  };
  assert.equal((await observe(db, null)).status, "disabled");
  assert.equal((await observe(db, null, null)).status, "disabled");
  for (const input of [
    null,
    {},
    [],
    { eventId: "evt_x", paymentId: "pi_x", checkoutId: "cs_x", livemode: false, revision: 0 },
    { eventId: ["evt_x"], paymentId: "pi_x", checkoutId: "cs_x", livemode: false, revision: 1 },
    { eventId: "evt_x", paymentId: "pi_x", checkoutId: "cs_x", livemode: "false", revision: 1 },
    {
      eventId: "evt_x",
      paymentId: "pi_x",
      checkoutId: "cs_x",
      livemode: false,
      revision: Number.MAX_SAFE_INTEGER,
    },
    {
      eventId: "evt_x",
      paymentId: "pi_x",
      checkoutId: "cs_x",
      livemode: false,
      revision: 1,
      raw: {},
    },
  ])
    assert.equal((await observe(db, input, on)).status, "unavailable");
  const accessor = {
    eventId: "evt_x",
    paymentId: "pi_x",
    checkoutId: "cs_x",
    livemode: false,
    get revision() {
      calls++;
      throw Error();
    },
  };
  assert.equal((await observe(db, accessor, on)).status, "unavailable");
  assert.equal((await cleanup(db)).status, "disabled");
  assert.equal((await cleanup(db, { ...on, limit: 257 })).status, "unavailable");
  assert.equal(calls, 0);
}
export async function duplicatesAtomicallyInvalidateAgeWithoutChangingCredit(db) {
  const f = await settled(db),
    before = (await all(db, "topup_purchases"))[0];
  const outcomes = await Promise.all([
    observe(db, f.observation, on),
    observe(db, f.observation, on),
  ]);
  assert.deepEqual(outcomes.map((r) => r.status).sort(), ["duplicate", "observed"]);
  assert.deepEqual((await all(db, "topup_purchases"))[0], before);
  const r = (await all(db, "topup_reconciliations"))[0],
    t = (await all(db, "topup_retention"))[0];
  assert.equal(r.revision, 2);
  assert.equal(r.loss, 0);
  assert.equal(r.full_refund, 0);
  assert.equal(r.hold_ids, "[]");
  assert.equal(t.resolved_at, null);
  assert.equal(t.resolved_zero_since, null);
  assert.equal(t.evidence_digest, null);
  assert.equal(t.history_proven, 1);
  const rows = await all(db, "topup_history_receipts");
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["event_digest", "observed_at"]);
  assert.match(rows[0].event_digest, /^[0-9a-f]{64}$/);
  assert.equal(new Date(rows[0].observed_at).toISOString(), rows[0].observed_at);
  assert.equal((await observe(db, f.observation, on)).status, "duplicate");
  assert.deepEqual(await all(db, "topup_history_receipts"), rows);
}
export async function observationBeforeFirstSettlementIsNotLost(db) {
  const f = await fixture(db);
  assert.equal((await observe(db, f.observation, on)).status, "pending");
  assert.deepEqual(await all(db, "topup_history_receipts"), []);
  assert.equal((await settleFirstTopup(db, f.capture, f.payment, f.reversals)).status, "settled");
  assert.equal((await observe(db, f.observation, on)).status, "observed");
  assert.equal((await readTopupRevision(db, f.key)).revision, 2);
  const g = await fixture(db);
  const [settlement, observed] = await Promise.all([
    settleFirstTopup(db, g.capture, g.payment, g.reversals),
    observe(db, g.observation, on),
  ]);
  assert.equal(settlement.status, "settled");
  assert.ok(["pending", "observed"].includes(observed.status));
  assert.equal(
    (await readTopupRevision(db, g.key)).revision,
    observed.status === "observed" ? 2 : 1,
  );
  assert.equal(
    (await all(db, "topup_history_receipts")).length,
    observed.status === "observed" ? 2 : 1,
  );
}
export async function associationAndModeAreExact(db) {
  const f = await settled(db),
    g = await settled(db);
  for (const patch of [
    { paymentId: g.payment.paymentId },
    { checkoutId: g.payment.checkoutId },
    { livemode: true },
    { revision: 2 },
  ]) {
    assert.equal((await observe(db, { ...f.observation, ...patch }, on)).status, "pending");
    assert.deepEqual(await all(db, "topup_history_receipts"), []);
  }
  const testDigest = await referenceHash("history-event", false, f.observation.eventId),
    liveDigest = await referenceHash("history-event", true, f.observation.eventId);
  assert.notEqual(testDigest, liveDigest);
  assert.equal((await observe(db, f.observation, on)).status, "observed");
  assert.equal((await all(db, "topup_history_receipts"))[0].event_digest, testDigest);
  assert.equal((await readTopupRevision(db, g.key)).revision, 1);
}
export async function sameStateNewEventStartsAnotherObservation(db) {
  const f = await settled(db);
  await observe(db, f.observation, on);
  assert.equal((await reconcileExistingTopup(db, f.key, 2, f.reversals)).status, "applied");
  const renewed = (await all(db, "topup_retention"))[0];
  assert.ok(renewed.resolved_at);
  assert.notEqual(renewed.resolved_at, "2020-01-01T00:00:00.000Z");
  assert.equal((await observe(db, f.observation, on)).status, "duplicate");
  assert.deepEqual((await all(db, "topup_retention"))[0], renewed);
  assert.equal(
    (await observe(db, { ...f.observation, eventId: "evt_round_trip", revision: 3 }, on)).status,
    "observed",
  );
  assert.equal((await all(db, "topup_retention"))[0].resolved_at, null);
  assert.equal((await all(db, "topup_history_receipts")).length, 2);
}
export async function staleCaptureAndConcurrentDistinctEventsDoNotConsumeReceipt(db) {
  const f = await settled(db);
  const outcomes = await Promise.all([
    observe(db, f.observation, on),
    observe(db, { ...f.observation, eventId: "evt_second" }, on),
  ]);
  assert.deepEqual(outcomes.map((r) => r.status).sort(), ["observed", "pending"]);
  assert.equal((await all(db, "topup_history_receipts")).length, 1);
  assert.equal((await reconcileExistingTopup(db, f.key, 1, f.reversals)).status, "stale");
}
export async function genuineRollbackPreservesAgeAndAllowsFreshObservation(db) {
  const f = await settled(db),
    before = (await all(db, "topup_retention"))[0];
  await db
    .prepare(
      "CREATE TRIGGER fixture_history_abort BEFORE UPDATE ON topup_retention BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END",
    )
    .run();
  assert.equal((await observe(db, f.observation, on)).status, "unavailable");
  assert.equal((await readTopupRevision(db, f.key)).revision, 1);
  assert.deepEqual(await all(db, "topup_history_receipts"), []);
  assert.deepEqual((await all(db, "topup_retention"))[0], before);
  await db.prepare("DROP TRIGGER fixture_history_abort").run();
  assert.equal((await observe(db, f.observation, on)).status, "observed");
}
export async function unknownCommittedAcknowledgementNeverRetries(db) {
  for (const fault of ["throw", "false", "hole", "badRow", "nullRow"]) {
    const f = await settled(db);
    let calls = 0;
    const wrapped = {
      prepare: (s) => db.prepare(s),
      batch: async (statements) => {
        calls++;
        const rows = await db.batch(statements);
        if (fault === "throw") throw Error("synthetic lost receipt");
        if (fault === "false") rows[0].success = false;
        if (fault === "hole") delete rows[1];
        if (fault === "badRow") rows[3].results[0] = { observed_at: ["2026-01-01"] };
        if (fault === "nullRow") rows[3].results[0] = null;
        return rows;
      },
    };
    assert.equal((await observe(wrapped, f.observation, on)).status, "unavailable");
    assert.equal(calls, 1);
    assert.equal((await readTopupRevision(db, f.key)).revision, 2);
    assert.equal((await observe(db, f.observation, on)).status, "duplicate");
    assert.equal((await readTopupRevision(db, f.key)).revision, 2);
  }
}
export async function accountDeletionOrderingKeepsOnlyUnlinkedReceipt(db) {
  const f = await settled(db);
  let deleted = false;
  const wrapped = {
    prepare: (s) => db.prepare(s),
    batch: async (statements) => {
      if (!deleted) {
        deleted = true;
        await deleteUser(db, f.user);
      }
      return db.batch(statements);
    },
  };
  assert.equal((await observe(wrapped, f.observation, on)).status, "pending");
  assert.deepEqual(await all(db, "topup_history_receipts"), []);
  assert.equal(await readTopupRevision(db, f.key), null);
  const g = await settled(db);
  assert.equal((await observe(db, g.observation, on)).status, "observed");
  const receipts = await all(db, "topup_history_receipts");
  await deleteUser(db, g.user);
  assert.deepEqual(await all(db, "topup_history_receipts"), receipts);
  assert.equal(await readTopupRevision(db, g.key), null);
  assert.equal((await observe(db, g.observation, on)).status, "duplicate");
}
export async function cleanupIsBoundedAtDatabaseThirtyDayCutoff(db) {
  for (const [digest, modifier] of [
    ["1", "-31 days"],
    ["2", "-30 days"],
    ["3", "-29 days"],
  ])
    await db
      .prepare(
        "INSERT INTO topup_history_receipts VALUES(?,strftime('%Y-%m-%dT%H:%M:%fZ','now',?))",
      )
      .bind(digest.repeat(64), modifier)
      .run();
  const plan = (
    await db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT event_digest FROM topup_history_receipts INDEXED BY topup_history_receipts_expiry WHERE observed_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') ORDER BY observed_at,event_digest LIMIT 1",
      )
      .all()
  ).results
    .map((r) => r.detail)
    .join(" ");
  assert.match(plan, /SEARCH/);
  assert.doesNotMatch(plan, /SCAN|TEMP/);
  assert.deepEqual(await cleanup(db, { ...on, limit: 1 }), { status: "cleaned", removed: 1 });
  assert.deepEqual(
    (await all(db, "topup_history_receipts")).map((r) => r.event_digest),
    ["2".repeat(64), "3".repeat(64)],
  );
  assert.deepEqual(await cleanup(db, { ...on, limit: 1 }), { status: "cleaned", removed: 1 });
  assert.deepEqual(await cleanup(db, { ...on, limit: 1 }), { status: "cleaned", removed: 0 });
}

export async function identicalSyntheticEventIdsRemainModeSeparated(db) {
  const f = await settled(db),
    g = await fixture(db, true);
  assert.equal((await settleFirstTopup(db, g.capture, g.payment, g.reversals)).status, "settled");
  assert.equal((await observe(db, f.observation, on)).status, "observed");
  assert.equal(
    (await observe(db, { ...g.observation, eventId: f.observation.eventId }, on)).status,
    "observed",
  );
  const receipts = await all(db, "topup_history_receipts");
  assert.equal(receipts.length, 2);
  assert.notEqual(receipts[0].event_digest, receipts[1].event_digest);
}

export async function nonterminalOrMismatchedAttemptCannotConsumeObservation(db) {
  for (const assignment of [
    "state='open'",
    "user_hash='" + "f".repeat(64) + "'",
    "offer_version='other'",
    "units=26",
  ]) {
    const f = await settled(db);
    await db
      .prepare(`UPDATE topup_checkout_attempts SET ${assignment} WHERE id=?`)
      .bind(f.payment.attemptId)
      .run();
    assert.equal((await observe(db, f.observation, on)).status, "pending");
    assert.deepEqual(await all(db, "topup_history_receipts"), []);
    assert.equal((await readTopupRevision(db, f.key)).revision, 1);
  }
}

export async function observationFencesAnAlreadyCapturedRetirement(db) {
  const f = await settled(db);
  const result = await retireResolvedTopup(db, f.key, async () => {
    assert.equal((await observe(db, f.observation, on)).status, "observed");
    return f.reversals;
  });
  assert.equal(result.status, "stale");
  assert.ok(await readTopupRevision(db, f.key));
  assert.equal((await all(db, "topup_claims"))[0].state, "granted");
  assert.equal((await all(db, "topup_history_receipts")).length, 1);
}
export async function unknownHistoryAndTerminalFlagsNeverBecomeQualified(db) {
  const f = await settled(db);
  await db
    .prepare(
      "UPDATE topup_reconciliations SET loss=1,full_refund=1,hold_ids=? WHERE payment_hash=?",
    )
    .bind(JSON.stringify(["synthetic-prior-cause"]), f.key)
    .run();
  await db
    .prepare("UPDATE topup_retention SET history_proven=0 WHERE payment_hash=?")
    .bind(f.key)
    .run();
  assert.equal((await observe(db, f.observation, on)).status, "observed");
  const state = (await all(db, "topup_reconciliations"))[0];
  assert.equal(state.loss, 1);
  assert.equal(state.full_refund, 1);
  assert.equal(state.hold_ids, '["synthetic-prior-cause"]');
  assert.equal((await all(db, "topup_retention"))[0].history_proven, 0);
}
