// Shared synthetic SQLite/actual local D1 evidence. No provider or account calls.
import assert from "node:assert/strict";
import {
  captureTopupSettlement as capture,
  settleFirstTopup as settle,
} from "../src/topup-first-settlement.js";
const rows = async (db, table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results;
async function fixture(db) {
  const id = crypto.randomUUID(),
    suffix = id.replaceAll("-", ""),
    user = suffix.repeat(2);
  await db
    .prepare(
      "INSERT INTO topup_checkout_attempts(id,user_hash,offer_version,amount,currency,units,created,state) " +
        "VALUES (?,?,'fixture-v1',300,'usd',25,'2026-11-10T00:00:00.000Z','creating')",
    )
    .bind(id, user)
    .run();
  const a = await capture(db, id);
  const p = {
    status: "paid_evidence",
    attemptId: id,
    userHash: user,
    offerVersion: "fixture-v1",
    offerAmount: 300,
    currency: "usd",
    units: 25,
    livemode: false,
    checkoutId: `cs_${suffix}`,
    paymentId: `pi_${suffix}`,
    chargeId: `ch_${suffix}`,
    capturedAmount: 327,
  };
  const r = {
    status: "reversal_evidence",
    paymentId: p.paymentId,
    checkoutId: p.checkoutId,
    chargeId: p.chargeId,
    livemode: p.livemode,
    currency: "usd",
    capturedAmount: 327,
    refunds: [],
    disputes: [],
    refundsComplete: true,
    disputesComplete: true,
  };
  return { a, p, r };
}
const apply = (db, f) => settle(db, f.a, f.p, f.r, new Date("2026-11-11T00:00:00Z"));
const reversal = (status, amount = 327) => ({
  id: `fixture-${status}`,
  status,
  amount,
  currency: "usd",
});
async function count(db, expected) {
  for (const table of [
    "topup_claims",
    "topup_purchases",
    "topup_reconciliations",
    "topup_retention",
  ])
    assert.equal((await rows(db, table)).length, expected);
}

export async function initialDispositions(db) {
  const cases = [
    [[], [], "available", 0, 0],
    [[reversal("succeeded", 100)], [], "available", 0, 0],
    [[reversal("pending")], [], "available", 0, 0],
    [[reversal("succeeded")], [], "revoked", 1, 0],
    [
      [reversal("succeeded", 100), { ...reversal("succeeded", 227), id: "second" }],
      [],
      "revoked",
      1,
      0,
    ],
    [[], [reversal("under_review", 1)], "held", 0, 0],
    [[], [reversal("lost", 1)], "revoked", 0, 1],
    [[], [reversal("warning_under_review", 1)], "available", 0, 0],
    [[reversal("succeeded")], [reversal("under_review", 1)], "revoked", 1, 0],
  ];
  for (const [refunds, disputes, disposition, full, loss] of cases) {
    const f = await fixture(db);
    f.r.refunds = refunds;
    f.r.disputes = disputes;
    const result = await apply(db, f);
    assert.equal(result.status, "settled");
    assert.equal(result.disposition, disposition);
    const purchase = await db
      .prepare("SELECT * FROM topup_purchases WHERE payment_hash=?")
      .bind(result.paymentHash)
      .first();
    for (const k of ["available", "held", "revoked"])
      assert.equal(purchase[k], k === disposition ? 25 : 0);
    assert.equal(purchase.consumed, 0);
    assert.equal(purchase.granted, 25);
    assert.equal(purchase.amount, 327);
    const retention = await db
      .prepare("SELECT * FROM topup_retention WHERE payment_hash=?")
      .bind(result.paymentHash)
      .first();
    const resolved =
      refunds.every((r) => !["pending", "requires_action"].includes(r.status)) &&
      disputes.every((d) => ["won", "warning_closed", "prevented", "lost"].includes(d.status));
    assert.equal(!!retention.resolved_at, resolved);
    assert.equal(!!retention.resolved_zero_since, resolved && disposition === "revoked");

    const state = await db
      .prepare("SELECT * FROM topup_reconciliations WHERE payment_hash=?")
      .bind(result.paymentHash)
      .first();
    assert.equal(state.revision, 1);
    assert.equal(state.full_refund, full);
    assert.equal(state.loss, loss);
    assert.deepEqual(
      JSON.parse(state.hold_ids),
      disposition === "held" ? ["fixture-under_review"] : [],
    );
    assert.equal(
      (
        await db
          .prepare("SELECT state FROM topup_checkout_attempts WHERE id=?")
          .bind(f.a.id)
          .first()
      ).state,
      "settled",
    );
    assert.equal(await capture(db, f.a.id), null);
    assert.deepEqual(await apply(db, f), { status: "stale" });
  }
  await count(db, cases.length);
  assert.equal((await rows(db, "topup_attempt_revisions")).length, 0);
  assert.equal((await rows(db, "bonus")).length, 0);
}

export async function settlementCapturesAndRaces(db) {
  const f = await fixture(db);
  const captured = await Promise.all([capture(db, f.a.id), capture(db, f.a.id)]);
  assert.deepEqual(captured.map((x) => x.revision).sort(), [2, 3]);
  assert.deepEqual(await apply(db, f), { status: "stale" });
  f.a = captured.find((x) => x.revision === 2);
  assert.deepEqual(await apply(db, f), { status: "stale" });
  // The newest read returning incomplete evidence must not re-enable an older capture.
  f.a = captured.find((x) => x.revision === 3);
  assert.deepEqual(await settle(db, f.a, f.p, { ...f.r, refundsComplete: false }), {
    status: "retry",
  });
  const outcomes = await Promise.all([apply(db, f), apply(db, f)]);
  assert.deepEqual(outcomes.map((x) => x.status).sort(), ["settled", "stale"]);
  await count(db, 1);
  const max = await fixture(db);
  await db
    .prepare("UPDATE topup_attempt_revisions SET revision=9007199254740990 WHERE attempt_id=?")
    .bind(max.a.id)
    .run();
  max.a = await capture(db, max.a.id);
  assert.equal(max.a.revision, Number.MAX_SAFE_INTEGER);
  assert.equal(await capture(db, max.a.id), null);
  assert.equal((await apply(db, max)).status, "settled");
  assert.equal(await capture(db, "not-an-attempt"), null);
}

export async function settlementAssociation(db) {
  const f = await fixture(db);
  for (const [part, key, value] of [
    ["p", "status", "pending"],
    ["p", "attemptId", crypto.randomUUID()],
    ["p", "userHash", "b".repeat(64)],
    ["p", "offerVersion", "other"],
    ["p", "offerAmount", 301],
    ["p", "currency", "eur"],
    ["p", "units", 26],
    ["p", "livemode", null],
    ["p", "capturedAmount", 299],
    ["p", "paymentId", "bad"],
    ["p", "chargeId", "bad"],
    ["r", "chargeId", "ch_other"],
    ["r", "livemode", true],
    ["r", "paymentId", "pi_other"],
    ["r", "checkoutId", "cs_other"],
    ["r", "capturedAmount", 328],
    ["r", "currency", "eur"],
    ["r", "disputesComplete", false],
    ["a", "revision", 0],
  ]) {
    const changed = structuredClone(f);
    changed[part][key] = value;
    assert.deepEqual(await apply(db, changed), { status: "retry" });
  }
  for (const key of ["user_hash", "offer_version", "amount", "currency", "units", "created"]) {
    const changed = structuredClone(f);
    changed.a[key] = key === "created" ? "changed" : f.a[key];
    if (key !== "created") {
      // A valid but false captured tuple must still be rejected by SQL.
      if (key === "user_hash") {
        changed.a[key] = "b".repeat(64);
        changed.p.userHash = changed.a[key];
      } else if (key === "offer_version") {
        changed.a[key] = "other";
        changed.p.offerVersion = "other";
      } else continue;
    }
    assert.deepEqual(await apply(db, changed), { status: "stale" });
  }
  await count(db, 0);
  assert.equal((await apply(db, f)).status, "settled");
}

export async function settlementCrossedClaims(db) {
  const first = await fixture(db);
  assert.equal((await apply(db, first)).status, "settled");
  const other = await fixture(db);
  assert.equal((await apply(db, other)).status, "settled");
  for (const [pi, cs] of [
    [first.p.paymentId, "cs_unused"],
    ["pi_unused", first.p.checkoutId],
    [first.p.paymentId, other.p.checkoutId],
  ]) {
    const f = await fixture(db);
    f.p.paymentId = f.r.paymentId = pi;
    f.p.checkoutId = f.r.checkoutId = cs;
    assert.deepEqual(await apply(db, f), { status: "stale" });
    assert.equal(
      (
        await db
          .prepare("SELECT state FROM topup_checkout_attempts WHERE id=?")
          .bind(f.a.id)
          .first()
      ).state,
      "creating",
    );
  }
  const a = await fixture(db),
    b = await fixture(db);
  b.p.paymentId = b.r.paymentId = a.p.paymentId;
  const result = await Promise.all([apply(db, a), apply(db, b)]);
  assert.deepEqual(result.map((x) => x.status).sort(), ["settled", "stale"]);
  await count(db, 3);
}

export async function settlementFenceAndDeletion(db) {
  const missing = await fixture(db);
  await db
    .prepare("DELETE FROM topup_attempt_revisions WHERE attempt_id=?")
    .bind(missing.a.id)
    .run();
  assert.deepEqual(await apply(db, missing), { status: "stale" });
  const removed = await fixture(db);
  await db.prepare("DELETE FROM topup_checkout_attempts WHERE id=?").bind(removed.a.id).run();
  assert.equal(await capture(db, removed.a.id), null);
  assert.deepEqual(await apply(db, removed), { status: "stale" });
  for (const state of ["expired", "settled"]) {
    const f = await fixture(db);
    await db
      .prepare("UPDATE topup_checkout_attempts SET state=? WHERE id=?")
      .bind(state, f.a.id)
      .run();
    assert.deepEqual(await apply(db, f), { status: "stale" });
  }
  const attached = await fixture(db);
  await db
    .prepare("UPDATE topup_checkout_attempts SET checkout_id=?,state='open' WHERE id=?")
    .bind(attached.p.checkoutId, attached.a.id)
    .run();
  assert.deepEqual(await apply(db, attached), { status: "stale" });
  attached.a = await capture(db, attached.a.id);
  const result = await apply(db, attached);
  assert.equal(result.status, "settled");
  // Simulate the required future atomic deletion; this is not production deletion wiring.
  await db.batch([
    db
      .prepare("UPDATE topup_claims SET state='deleted' WHERE payment_hash=?")
      .bind(result.paymentHash),
    db.prepare("DELETE FROM topup_purchases WHERE payment_hash=?").bind(result.paymentHash),
    db.prepare("DELETE FROM topup_checkout_attempts WHERE id=?").bind(attached.a.id),
  ]);
  assert.deepEqual(await apply(db, attached), { status: "stale" });
  const replay = await fixture(db);
  replay.p.paymentId = replay.r.paymentId = attached.p.paymentId;
  replay.p.checkoutId = replay.r.checkoutId = attached.p.checkoutId;
  assert.deepEqual(await apply(db, replay), { status: "stale" });
  assert.equal((await rows(db, "topup_claims"))[0].state, "deleted");
  assert.equal((await rows(db, "topup_purchases")).length, 0);
}

export async function settlementRollback(db) {
  const f = await fixture(db);
  await db
    .prepare(
      "CREATE TRIGGER fixture_settlement_abort BEFORE UPDATE ON topup_checkout_attempts " +
        "WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'fixture_rollback'); END",
    )
    .run();
  await assert.rejects(() => apply(db, f), /fixture_rollback/);
  await count(db, 0);
  assert.equal((await rows(db, "topup_attempt_revisions"))[0].revision, 1);
  assert.equal((await rows(db, "topup_checkout_attempts"))[0].state, "creating");
  await db.prepare("DROP TRIGGER fixture_settlement_abort").run();
  await db
    .prepare(
      "CREATE TRIGGER fixture_retention_abort BEFORE INSERT ON topup_retention BEGIN SELECT RAISE(ABORT,'fixture_retention_rollback'); END",
    )
    .run();
  await assert.rejects(() => apply(db, f), /fixture_retention_rollback/);
  await count(db, 0);
  assert.equal((await rows(db, "topup_checkout_attempts"))[0].state, "creating");
  assert.equal((await rows(db, "topup_attempt_revisions"))[0].revision, 1);
  await db.prepare("DROP TRIGGER fixture_retention_abort").run();
  assert.equal((await apply(db, f)).status, "settled");
}

export async function settlementTransactionGuards(db) {
  const mutations = [
    (f) => capture(db, f.a.id),
    (f) => db.prepare("DELETE FROM topup_checkout_attempts WHERE id=?").bind(f.a.id).run(),
    (f) => db.prepare("DELETE FROM topup_attempt_revisions WHERE attempt_id=?").bind(f.a.id).run(),
    (f) =>
      db
        .prepare("UPDATE topup_checkout_attempts SET checkout_id=?,state='open' WHERE id=?")
        .bind(f.p.checkoutId, f.a.id)
        .run(),
    ...[
      ["state", "expired"],
      ["user_hash", "c".repeat(64)],
      ["offer_version", "other"],
      ["amount", 301],
      ["currency", "eur"],
      ["units", 26],
      ["created", "changed"],
    ].map(
      ([key, value]) =>
        (f) =>
          db
            .prepare(`UPDATE topup_checkout_attempts SET ${key}=? WHERE id=?`)
            .bind(value, f.a.id)
            .run(),
    ),
  ];
  for (const mutate of mutations) {
    const f = await fixture(db);
    const guarded = {
      prepare: (sql) => db.prepare(sql),
      batch: async (statements) => {
        // Change durable state after validation/hash awaits, immediately before the real batch.
        await mutate(f);
        return db.batch(statements);
      },
    };
    assert.deepEqual(await apply(guarded, f), { status: "stale" });
    await count(db, 0);
  }
  const f = await fixture(db),
    now = new Date("2026-11-11T00:00:00Z");
  const pending = settle(db, f.a, f.p, f.r, now);
  now.setTime(NaN); // Mutate during asynchronous hashing, before SQL construction.
  const result = await pending;
  assert.equal(result.status, "settled");
  assert.equal(
    (
      await db
        .prepare("SELECT created FROM topup_purchases WHERE payment_hash=?")
        .bind(result.paymentHash)
        .first()
    ).created,
    "2026-11-11T00:00:00.000Z",
  );
}
