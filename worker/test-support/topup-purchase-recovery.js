// Real readers and SQL helpers; synthetic GET responses only in Node and local Workers/D1.
import assert from "node:assert/strict";
import { recoverTopupPurchase as recover } from "../src/topup-purchase-recovery.js";
import { captureTopupSettlement, settleFirstTopup } from "../src/topup-first-settlement.js";
import { deleteUser } from "../src/limits.js";
import { attempt, session } from "./topup-stripe.js";
const env = { STRIPE_SECRET_KEY: "fixture-not-a-key", TOPUPS_ENABLED: "0", PAYMENTS_ENABLED: "0" };
const offer = {
  version: "topup-v1",
  priceId: "price_fixture",
  livemode: false,
  amount: 300,
  currency: "usd",
  units: 25,
};
const now = new Date("2026-11-11T00:00:00Z");
const pending = { status: "pending" };
const rows = async (db, table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results;
const balances = (db) =>
  db.prepare("SELECT available,held,consumed,revoked FROM topup_purchases").first();
const financial = async (db) =>
  Promise.all(
    ["topup_claims", "topup_purchases", "topup_reconciliations", "topup_checkout_attempts"].map(
      (t) => rows(db, t),
    ),
  );
const item = (
  kind,
  status,
  amount = 327,
  id = kind === "refund" ? "re_fixture" : "du_fixture",
) => ({
  object: kind,
  id,
  charge: "ch_fixture",
  payment_intent: "pi_fixture",
  currency: "usd",
  amount,
  status,
  ...(kind === "dispute" ? { livemode: false } : {}),
});
async function setup(db) {
  await db.batch(
    [
      "DROP TRIGGER IF EXISTS fixture_purchase_abort",
      ...[
        "topup_allocations",
        "topup_reconciliations",
        "topup_purchases",
        "topup_claims",
        "topup_attempt_revisions",
        "topup_checkout_attempts",
        "forget",
      ].map((t) => `DELETE FROM ${t}`),
    ].map((sql) => db.prepare(sql)),
  );
  const a = { ...attempt(), state: "open", checkout_id: "cs_fixture" };
  await db
    .prepare("INSERT INTO topup_checkout_attempts VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(
      a.id,
      a.user_hash,
      a.offer_version,
      a.amount,
      a.currency,
      a.units,
      now.toISOString(),
      a.checkout_id,
      a.state,
    )
    .run();
  const payment = {
    status: "paid_evidence",
    attemptId: a.id,
    userHash: a.user_hash,
    offerVersion: a.offer_version,
    offerAmount: 300,
    units: 25,
    currency: "usd",
    livemode: false,
    checkoutId: a.checkout_id,
    paymentId: "pi_fixture",
    chargeId: "ch_fixture",
    capturedAmount: 327,
  };
  const result = await settleFirstTopup(
    db,
    await captureTopupSettlement(db, a.id),
    payment,
    {
      ...payment,
      status: "reversal_evidence",
      refunds: [],
      disputes: [],
      refundsComplete: true,
      disputesComplete: true,
    },
    now,
  );
  assert.equal(result.status, "settled");
  const checkout = {
    ...session(a),
    status: "complete",
    payment_status: "paid",
    recovered_from: null,
    payment_intent: "pi_fixture",
    url: null,
  };
  checkout.line_items.data[0].price.active = false;
  const f = {
    a,
    key: result.paymentHash,
    checkout,
    intent: {
      object: "payment_intent",
      id: "pi_fixture",
      status: "succeeded",
      amount: 327,
      amount_received: 327,
      amount_capturable: 0,
      currency: "usd",
      livemode: false,
      latest_charge: "ch_fixture",
      metadata: { ...checkout.metadata },
    },
    charge: {
      object: "charge",
      id: "ch_fixture",
      payment_intent: "pi_fixture",
      status: "succeeded",
      amount: 327,
      amount_captured: 327,
      captured: true,
      paid: true,
      currency: "usd",
      livemode: false,
      amount_refunded: 0,
      refunded: false,
      disputed: false,
    },
    refunds: [],
    disputes: [],
    calls: [],
    before: async () => {},
    alter: () => {},
  };
  f.fetch = async (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal);
    assert.equal(options.headers["Stripe-Version"], "2026-08-26.dahlia");
    f.calls.push(url);
    await f.before(url);
    const path = new URL(url).pathname;
    let value;
    if (path === "/v1/checkout/sessions/cs_fixture") value = f.checkout;
    else if (path === "/v1/payment_intents/pi_fixture") value = f.intent;
    else if (path === "/v1/charges/ch_fixture") value = f.charge;
    else {
      const kind = path.slice(4);
      assert.ok(["refunds", "disputes"].includes(kind));
      assert.equal(new URL(url).searchParams.get("charge"), "ch_fixture");
      value = { object: "list", url: path, data: f[kind], has_more: false };
    }
    value = structuredClone(value);
    f.alter(value, path);
    return new Response(JSON.stringify(value));
  };
  f.run = (source = db, historical = offer) => recover(source, env, f.key, historical, f.fetch);
  return f;
}

export async function purchaseRefreshLifecycle(db) {
  const f = await setup(db);
  f.before = async () => assert.equal((await rows(db, "topup_reconciliations"))[0].revision, 1);
  assert.equal((await f.run()).status, "applied");
  assert.equal(f.calls.length, 9);
  f.before = async () => {};
  f.refunds = [item("refund", "succeeded", 100)];
  f.charge.amount_refunded = 100;
  f.disputes = [item("dispute", "warning_under_review", 1)];
  f.charge.disputed = true;
  assert.equal((await f.run()).decision.disposition, "available");
  f.disputes = [item("dispute", "under_review", 1)];
  assert.equal((await f.run()).decision.disposition, "held");
  assert.deepEqual(await balances(db), { available: 0, held: 25, consumed: 0, revoked: 0 });
  const held = await financial(db);
  f.disputes = [item("dispute", "won", 1, "du_unrelated")];
  assert.equal((await f.run()).status, "retry");
  assert.deepEqual(await financial(db), held);
  f.disputes = [item("dispute", "won", 1)];
  assert.equal((await f.run()).decision.disposition, "available");
  f.refunds = [item("refund", "succeeded")];
  f.charge.amount_refunded = 327;
  f.charge.refunded = true;
  assert.equal((await f.run()).decision.disposition, "revoked");
  f.refunds = [];
  f.charge.amount_refunded = 0;
  f.charge.refunded = false;
  assert.equal((await f.run()).decision.disposition, "revoked");
  assert.deepEqual(await balances(db), { available: 0, held: 0, consumed: 0, revoked: 25 });
  const lost = await setup(db);
  await db.prepare("UPDATE topup_purchases SET available=0,consumed=25").run();
  lost.disputes = [item("dispute", "under_review", 1)];
  lost.charge.disputed = true;
  assert.equal((await lost.run()).decision.disposition, "held");
  lost.disputes = [item("dispute", "lost", 1)];
  assert.equal((await lost.run()).decision.disposition, "revoked");
  lost.disputes = [item("dispute", "won", 1)];
  const appeal = await lost.run();
  assert.equal(appeal.decision.manualReview, true);
  assert.equal(appeal.decision.disposition, "revoked");
  assert.deepEqual(await balances(db), { available: 0, held: 0, consumed: 25, revoked: 0 });
}

export async function purchaseRefreshIdentityAndMissingAssociation(db) {
  for (const sql of [
    "DELETE FROM topup_checkout_attempts",
    "UPDATE topup_checkout_attempts SET state='open'",
    "UPDATE topup_checkout_attempts SET user_hash='" + "b".repeat(64) + "'",
    "UPDATE topup_checkout_attempts SET units=26",
    "UPDATE topup_checkout_attempts SET offer_version='other'",
  ]) {
    const f = await setup(db);
    await db.prepare(sql).run();
    const before = await financial(db);
    assert.equal((await f.run()).status, "unavailable");
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await financial(db), before);
  }
  const f = await setup(db),
    before = await financial(db);
  assert.deepEqual(await f.run(db, { ...offer, livemode: true }), pending);
  assert.equal(f.calls.length, 0);
  await db.prepare("UPDATE topup_claims SET checkout_hash=?").bind("f".repeat(64)).run();
  assert.deepEqual(await f.run(), pending);
  assert.equal(f.calls.length, 0);
  assert.deepEqual((await financial(db)).slice(1), before.slice(1));
  for (const alter of [
    (v, p) => {
      if (p.includes("checkout")) v.metadata.user_hash = "b".repeat(64);
    },
    (v, p) => {
      if (p.includes("checkout")) v.status = "expired";
    },
    (v, p) => {
      if (p.includes("charges")) v.id = "ch_other";
    },
    (v, p) => {
      if (p.includes("payment_intents")) v.livemode = true;
    },
    (v, p) => {
      if (p.includes("disputes")) v.has_more = true;
    },
  ]) {
    const f = await setup(db);
    f.alter = alter;
    const old = await financial(db);
    assert.deepEqual(await f.run(), pending);
    assert.deepEqual(await financial(db), old);
  }
  // A coherent equal-value alternate payment must still match the immutable purchase.
  const other = await setup(db);
  other.checkout.payment_intent = "pi_other";
  other.intent.id = "pi_other";
  other.charge.payment_intent = "pi_other";
  const original = other.fetch;
  other.fetch = (url, options) =>
    original(url.replace("payment_intents/pi_other", "payment_intents/pi_fixture"), options);
  const old = await financial(db);
  assert.deepEqual(await other.run(), pending);
  assert.deepEqual(await financial(db), old);
}

export async function purchaseRefreshCommitOrdering(db) {
  for (const newerFails of [false, true]) {
    const f = await setup(db);
    let release, started;
    const gate = new Promise((r) => {
        release = r;
      }),
      ready = new Promise((r) => {
        started = r;
      });
    const original = f.fetch;
    let first = true;
    f.fetch = async (...args) => {
      if (first) {
        first = false;
        started();
        await gate;
      }
      return original(...args);
    };
    const older = f.run();
    await ready;
    const newer = await recover(db, newerFails ? {} : env, f.key, offer, original);
    assert.equal(newer.status, newerFails ? "pending" : "applied");
    release();
    assert.equal((await older).status, newerFails ? "applied" : "stale");
    assert.equal((await rows(db, "topup_reconciliations"))[0].revision, 2);
  }
  for (const change of ["available=20,consumed=5", "available=24,consumed=1"]) {
    const f = await setup(db);
    await db.prepare("UPDATE topup_purchases SET available=23,consumed=2").run();
    f.before = async () => {
      f.before = async () => {};
      await db.prepare("UPDATE topup_purchases SET " + change).run();
    };
    f.disputes = [item("dispute", "under_review", 1)];
    f.charge.disputed = true;
    assert.equal((await f.run()).decision.disposition, "held");
    const b = await balances(db);
    assert.equal(b.available, 0);
    assert.equal(b.held + b.consumed, 25);
    assert.equal(b.held, change.startsWith("available=20") ? 20 : 24);
  }
}

export async function purchaseRefreshDeletionAndRollback(db) {
  for (const action of [
    async (db, f) => deleteUser(db, f.a.user_hash, now),
    async (db) => db.prepare("UPDATE topup_claims SET state='retired'").run(),
  ]) {
    const f = await setup(db);
    f.before = async () => {
      f.before = async () => {};
      await action(db, f);
    };
    assert.equal((await f.run()).status, "unavailable");
    const after = await financial(db);
    const count = f.calls.length;
    assert.equal((await f.run()).status, "unavailable");
    assert.equal(f.calls.length, count);
    assert.deepEqual(await financial(db), after);
  }
  const f = await setup(db);
  f.disputes = [item("dispute", "under_review", 1)];
  f.charge.disputed = true;
  const before = await financial(db);
  await db
    .prepare(
      "CREATE TRIGGER fixture_purchase_abort BEFORE UPDATE ON topup_purchases BEGIN SELECT RAISE(ABORT,'fixture_rollback'); END",
    )
    .run();
  await assert.rejects(f.run(), /fixture_rollback/);
  assert.deepEqual(await financial(db), before);
  await db.prepare("DROP TRIGGER fixture_purchase_abort").run();
  assert.equal((await f.run()).decision.disposition, "held");
}

export async function purchaseRefreshBoundedFailureAndInputs(db) {
  for (const phase of ["checkout", "refunds"]) {
    const f = await setup(db);
    const before = await financial(db);
    f.alter = (v, p) => {
      if (p.includes(phase)) v.padding = "x".repeat(262145);
    };
    assert.deepEqual(await f.run(), pending);
    assert.deepEqual(await financial(db), before);
  }
  const f = await setup(db),
    before = await financial(db);
  f.fetch = async () => {
    throw new Error("synthetic unavailable");
  };
  assert.deepEqual(await f.run(), pending);
  assert.deepEqual(await financial(db), before);
  assert.deepEqual(await recover(db, env, f.key, offer, null), pending);
  assert.deepEqual(
    await recover(db, env, f.key, { ...offer, livemode: undefined }, f.fetch),
    pending,
  );
  assert.equal((await recover(db, env, "f".repeat(64), offer, f.fetch)).status, "unavailable");
  // Inputs are copied before the first asynchronous DB read; caller mutations cannot change evidence configuration.
  const historical = { ...offer },
    config = { ...env };
  let mutated = false;
  const wrapped = {
    prepare(sql) {
      if (!mutated) {
        mutated = true;
        historical.livemode = true;
        config.STRIPE_SECRET_KEY = "";
      }
      return db.prepare(sql);
    },
    batch: (s) => db.batch(s),
  };
  const good = await setup(db);
  assert.equal(
    (await recover(wrapped, config, good.key, historical, good.fetch)).status,
    "applied",
  );
}

// The same appended scenarios run through the registered Node and actual D1 wrappers.
import { recoverVerifiedTopupReversalEvent as recoverEvent } from "../src/topup-reversal-events.js";
import { referenceHash } from "../src/topup-ledger.js";
import { hmacHex, verifyWebhook } from "../src/billing.js";
const reversalEvent = (type = "refund.updated") => {
  const kind =
    type === "charge.refunded"
      ? "charge"
      : type.startsWith("charge.dispute.")
        ? "dispute"
        : "refund";
  return {
    object: "event",
    id: "evt_fixture",
    type,
    livemode: false,
    data: {
      object: {
        object: kind,
        id: { refund: "re_fixture", charge: "ch_fixture", dispute: "du_fixture" }[kind],
        payment_intent: "pi_fixture",
        ...(kind === "refund" ? {} : { livemode: false }),
        status: "lost",
        amount_refunded: 999999,
        refunded: true,
      },
    },
  };
};
const eventOptions = (db, f, event = reversalEvent()) => ({
  db,
  env,
  event,
  fetchImpl: f.fetch,
  resolveOffer: (version, mode) => {
    assert.equal(version, offer.version);
    assert.equal(mode, false);
    return offer;
  },
});

export async function reversalEventContractsAndAuthoritativeRecovery(db) {
  for (const type of [
    "refund.created",
    "refund.updated",
    "refund.failed",
    "charge.refund.updated",
    "charge.refunded",
    "charge.dispute.created",
    "charge.dispute.updated",
    "charge.dispute.closed",
    "charge.dispute.funds_withdrawn",
    "charge.dispute.funds_reinstated",
  ]) {
    const f = await setup(db),
      event = reversalEvent(type);
    const body = JSON.stringify(event),
      second = Math.floor(now.getTime() / 1000),
      secret = "synthetic-signature-fixture";
    const signature = await hmacHex(secret, second + "." + body);
    const verified = await verifyWebhook(secret, `t=${second},v1=${signature}`, body, now);
    assert.deepEqual(await recoverEvent(eventOptions(db, f, verified)), { status: "reconciled" });
    assert.equal(f.calls.length, 9);
    assert.deepEqual(await balances(db), { available: 25, held: 0, consumed: 0, revoked: 0 });
  }
  const f = await setup(db),
    event = reversalEvent();
  event.data.object.payment_intent = {
    object: "payment_intent",
    id: "pi_fixture",
    livemode: false,
  };
  // Event claims a loss; only the authoritative current full refund determines revocation.
  f.refunds = [item("refund", "succeeded")];
  f.charge.amount_refunded = 327;
  f.charge.refunded = true;
  assert.deepEqual(await recoverEvent(eventOptions(db, f, event)), { status: "reconciled" });
  assert.deepEqual(await balances(db), { available: 0, held: 0, consumed: 0, revoked: 25 });
}

export async function reversalEventMissingAmbiguousAndMode(db) {
  const f = await setup(db),
    before = await financial(db);
  const mutations = [
    (e) => delete e.data.object.payment_intent,
    (e) => {
      e.data.object.payment_intent = null;
    },
    (e) => {
      e.data.object.payment_intent = " pi_fixture";
    },
    (e) => {
      e.data.object.payment_intent = { id: "pi_fixture" };
    },
    (e) => {
      e.data.object.payment_intent = { object: "payment_intent", id: "pi_fixture", livemode: true };
    },
    (e) => {
      e.livemode = "false";
    },
    (e) => {
      e.data.object.livemode = true;
    },
    (e) => {
      e.object = "refund";
    },
    (e) => {
      e.id = "wrong";
    },
    (e) => {
      e.data.object.object = "charge";
    },
    (e) => {
      e.data.object.id = "wrong";
    },
    (e) => {
      e.account = "synthetic-context";
    },
    (e) => {
      e.context = "synthetic-context";
    },
  ];
  for (const mutate of mutations) {
    const event = reversalEvent();
    mutate(event);
    assert.deepEqual(await recoverEvent(eventOptions(db, f, event)), pending);
  }
  const missingMode = reversalEvent("charge.dispute.created");
  delete missingMode.data.object.livemode;
  assert.deepEqual(await recoverEvent(eventOptions(db, f, missingMode)), pending);
  const unknown = reversalEvent();
  unknown.data.object.payment_intent = "pi_unknown";
  assert.deepEqual(await recoverEvent(eventOptions(db, f, unknown)), { status: "unclassified" });
  const otherMode = reversalEvent();
  otherMode.livemode = true;
  assert.deepEqual(await recoverEvent(eventOptions(db, f, otherMode)), { status: "unclassified" });
  assert.deepEqual(await recoverEvent(eventOptions(db, f, { type: "charge.updated" })), {
    status: "unclassified",
  });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await financial(db), before);
  // Same raw provider ID may occur in the other mode: retained live and active test claims stay distinct.
  await db
    .prepare("INSERT INTO topup_claims VALUES(?,?,'retired')")
    .bind(
      await referenceHash("payment", true, "pi_fixture"),
      await referenceHash("checkout", true, "cs_fixture"),
    )
    .run();
  assert.deepEqual(await recoverEvent(eventOptions(db, f, otherMode)), { status: "inactive" });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await recoverEvent(eventOptions(db, f)), { status: "reconciled" });
}

export async function reversalEventRetainedCollisionAndUnavailable(db) {
  for (const terminal of ["deleted", "retired"]) {
    const f = await setup(db);
    if (terminal === "deleted") await deleteUser(db, f.a.user_hash, now);
    else
      await db.batch([
        db.prepare("UPDATE topup_claims SET state='retired'"),
        db.prepare("DELETE FROM topup_purchases"),
      ]);
    const before = await financial(db);
    assert.deepEqual(
      await recoverEvent({
        ...eventOptions(db, f),
        resolveOffer: () => assert.fail("no config lookup"),
        fetchImpl: null,
      }),
      { status: "inactive" },
    );
    assert.deepEqual(await financial(db), before);
    assert.equal(f.calls.length, 0);
  }
  for (const sql of [
    "UPDATE topup_purchases SET payment_id='pi_other'",
    "UPDATE topup_claims SET checkout_hash=lower(hex(zeroblob(32)))",
    "DELETE FROM topup_purchases",
  ]) {
    const f = await setup(db);
    await db.prepare(sql).run();
    assert.deepEqual(await recoverEvent(eventOptions(db, f)), pending);
    assert.equal(f.calls.length, 0);
  }
  const f = await setup(db),
    before = await financial(db);
  for (const historical of [null, { ...offer, version: "other" }, { ...offer, livemode: true }])
    assert.deepEqual(
      await recoverEvent({ ...eventOptions(db, f), resolveOffer: () => historical }),
      pending,
    );
  const real = await db.batch([
    db.prepare(
      "SELECT c.state,c.checkout_hash,p.payment_id,p.checkout_id,p.offer_version FROM topup_claims c JOIN topup_purchases p ON p.payment_hash=c.payment_hash",
    ),
  ]);
  for (const result of [
    [{ success: false, results: [] }],
    [{ ...real[0], results: [real[0].results[0], real[0].results[0]] }],
    [],
  ]) {
    const wrapped = { prepare: (sql) => db.prepare(sql), batch: async () => result };
    assert.deepEqual(await recoverEvent(eventOptions(wrapped, f)), pending);
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await financial(db), before);
  assert.deepEqual(
    await recoverEvent({
      ...eventOptions(db, f),
      fetchImpl: async () => {
        throw Error("synthetic detail must not escape");
      },
    }),
    pending,
  );
  assert.deepEqual(await financial(db), before);
}

export async function reversalEventDeletionDuringHistoricalLookup(db) {
  const f = await setup(db);
  const options = {
    ...eventOptions(db, f),
    resolveOffer: async () => {
      await deleteUser(db, f.a.user_hash, now);
      return offer;
    },
  };
  assert.deepEqual(await recoverEvent(options), pending);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await recoverEvent(options), { status: "inactive" });
  assert.equal((await rows(db, "topup_purchases")).length, 0);
}
