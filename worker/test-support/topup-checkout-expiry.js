// Synthetic only: identical scenarios in SQLite and actual local D1.
import assert from "node:assert/strict";
import {
  captureTopupSettlement as capture,
  settleFirstTopup as settle,
} from "../src/topup-first-settlement.js";
import { expireTopupCheckout as expire } from "../src/topup-checkout-expiry.js";
import { reserveTopupCheckout as reserve } from "../src/topup-checkout.js";
import { readTopupPaymentEvidence as read } from "../src/topup-payment-evidence.js";
import { referenceHash } from "../src/topup-ledger.js";
import { session } from "./topup-stripe.js";
const offer = {
  version: "topup-v1",
  priceId: "price_fixture",
  amount: 300,
  currency: "usd",
  units: 25,
  livemode: false,
};
const row = (db, id) =>
  db.prepare("SELECT * FROM topup_checkout_attempts WHERE id=?").bind(id).first();
async function fixture(db, state = "creating") {
  const id = crypto.randomUUID(),
    suffix = id.replaceAll("-", ""),
    user = suffix.repeat(2),
    cs = `cs_${suffix}`;
  await db
    .prepare(
      "INSERT INTO topup_checkout_attempts(id,user_hash,offer_version,amount,currency,units,created,state,checkout_id) " +
        "VALUES (?,?,'topup-v1',300,'usd',25,'2000-01-01T00:00:00Z',?,?)",
    )
    .bind(id, user, state, state === "open" ? cs : null)
    .run();
  return {
    a: await capture(db, id),
    e: {
      status: "expired_evidence",
      attemptId: id,
      checkoutId: cs,
      userHash: user,
      offerVersion: "topup-v1",
      offerAmount: 300,
      currency: "usd",
      units: 25,
      livemode: false,
    },
  };
}
async function noPurchases(db) {
  assert.equal((await db.prepare("SELECT count(*) AS n FROM topup_purchases").first()).n, 0);
}
async function verified(db, f, branch, change = () => {}) {
  const checkout = {
    ...session(),
    id: f.e.checkoutId,
    client_reference_id: f.a.user_hash,
    status: "expired",
    payment_status: "unpaid",
    recovered_from: null,
    payment_intent: branch === 0 ? null : "pi_fixture",
    url: null,
  };
  checkout.metadata = {
    kind: "autofill_topup",
    attempt_id: f.a.id,
    user_hash: f.a.user_hash,
    offer_version: f.a.offer_version,
    units: "25",
  };
  const intent = {
    object: "payment_intent",
    id: "pi_fixture",
    status: "canceled",
    currency: "usd",
    livemode: false,
    amount: 327,
    amount_received: 0,
    amount_capturable: 0,
    metadata: checkout.metadata,
    latest_charge: branch === 1 ? null : "ch_fixture",
  };
  const charge = {
    object: "charge",
    id: "ch_fixture",
    currency: "usd",
    livemode: false,
    payment_intent: "pi_fixture",
    amount: 327,
    status: "failed",
    paid: false,
    captured: false,
    amount_captured: 0,
  };
  change({ checkout, intent, charge });
  let calls = 0;
  const result = await read(
    { STRIPE_SECRET_KEY: "fixture-not-a-key" },
    f.a,
    offer,
    async (url, options) => {
      calls++;
      assert.equal(options.method, "GET");
      assert.equal(options.body, undefined);
      const path = new URL(url).pathname;
      const value =
        path === `/v1/checkout/sessions/${f.e.checkoutId}`
          ? checkout
          : path === "/v1/payment_intents/pi_fixture"
            ? intent
            : path === "/v1/charges/ch_fixture"
              ? charge
              : null;
      assert.ok(value);
      return new Response(JSON.stringify(value));
    },
    f.e.checkoutId,
  );
  return { result, calls };
}

export async function expiryVerifiedLifecycle(db) {
  for (const branch of [0, 1, 2]) {
    const f = await fixture(db, branch === 1 ? "open" : "creating");
    let creates = 0;
    const capability = {
      enabled: true,
      offer: { ...offer, verified: true },
      create: async () => {
        creates++;
        throw new Error("synthetic unknown creation");
      },
    };
    const blocked = await reserve(db, f.a.user_hash, capability);
    assert.equal(blocked.attempt.id, f.a.id);
    assert.equal(creates, 0);
    const { result, calls } = await verified(db, f, branch);
    assert.equal(result.status, "expired_evidence");
    assert.equal(calls, branch + 1);
    assert.deepEqual(await expire(db, f.a, result), { status: "expired" });
    assert.equal((await row(db, f.a.id)).checkout_id, f.e.checkoutId);
    assert.equal(await capture(db, f.a.id), null);
    assert.deepEqual(await expire(db, f.a, result), { status: "stale" });
    const next = await reserve(db, f.a.user_hash, capability);
    assert.notEqual(next.attempt.id, f.a.id);
    assert.equal(creates, 1);
    assert.equal(next.attempt.state, "creating"); // Remains ambiguous; no timer-driven reopen.
  }
  await noPurchases(db);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM topup_claims").first()).n, 0);
}

export async function expiryRejectsUnknown(db) {
  const f = await fixture(db);
  for (const [key, value] of [
    ["status", "pending"],
    ["status", "paid_evidence"],
    ["attemptId", crypto.randomUUID()],
    ["userHash", "b".repeat(64)],
    ["offerVersion", "other"],
    ["offerAmount", 301],
    ["currency", "eur"],
    ["units", 26],
    ["livemode", null],
    ["checkoutId", null],
  ])
    assert.deepEqual(await expire(db, f.a, { ...f.e, [key]: value }), { status: "retry" });
  for (const alter of [
    (d) => (d.checkout.status = "open"),
    (d) => (d.checkout.status = "complete"),
    (d) => (d.checkout.livemode = true),
    (d) => (d.intent.amount_received = 327),
    (d) => (d.intent.status = "processing"),
    (d) => (d.charge.amount_captured = 1),
  ]) {
    const { result } = await verified(db, f, 2, alter);
    assert.deepEqual(result, { status: "pending" });
    assert.deepEqual(await expire(db, f.a, result), { status: "retry" });
  }
  assert.equal((await row(db, f.a.id)).state, "creating"); // Old creation time is deliberately irrelevant.
  const open = await fixture(db, "open");
  assert.deepEqual(await expire(db, open.a, { ...open.e, checkoutId: "cs_other" }), {
    status: "retry",
  });
  await noPurchases(db);
}

export async function expiryClaimsAndRaces(db) {
  for (const state of ["granted", "deleted", "retired"]) {
    const f = await fixture(db);
    await db
      .prepare("INSERT INTO topup_claims(payment_hash,checkout_hash,state) VALUES (?,?,?)")
      .bind(
        await referenceHash("payment", false, `pi_${state}`),
        await referenceHash("checkout", false, f.e.checkoutId),
        state,
      )
      .run();
    assert.deepEqual(await expire(db, f.a, f.e), { status: "stale" });
    assert.equal((await row(db, f.a.id)).state, "creating");
  }
  const f = await fixture(db),
    old = f.a;
  f.a = await capture(db, f.a.id);
  assert.deepEqual(await expire(db, old, f.e), { status: "stale" });
  const both = await Promise.all([expire(db, f.a, f.e), expire(db, f.a, f.e)]);
  assert.deepEqual(both.map((x) => x.status).sort(), ["expired", "stale"]);
  const max = await fixture(db);
  await db
    .prepare("UPDATE topup_attempt_revisions SET revision=9007199254740991 WHERE attempt_id=?")
    .bind(max.a.id)
    .run();
  max.a.revision = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(await expire(db, max.a, max.e), { status: "expired" });
  for (const expiryFirst of [true, false]) {
    const race = await fixture(db),
      p = {
        ...race.e,
        status: "paid_evidence",
        paymentId: `pi_${race.a.id.replaceAll("-", "")}`,
        chargeId: "ch_fixture",
        capturedAmount: 327,
      };
    const r = {
      ...p,
      status: "reversal_evidence",
      refunds: [],
      disputes: [],
      refundsComplete: true,
      disputesComplete: true,
    };
    const exp = () => expire(db, race.a, race.e),
      paid = () => settle(db, race.a, p, r);
    const result = await Promise.all(expiryFirst ? [exp(), paid()] : [paid(), exp()]);
    assert.equal(result.filter((x) => ["expired", "settled"].includes(x.status)).length, 1);
    assert.equal(result.filter((x) => x.status === "stale").length, 1);
    const ended = (await row(db, race.a.id)).state;
    const purchases = await db
      .prepare("SELECT count(*) AS n FROM topup_purchases WHERE checkout_id=?")
      .bind(race.e.checkoutId)
      .first();
    assert.equal(purchases.n, ended === "settled" ? 1 : 0);
    assert.deepEqual(await expire(db, race.a, race.e), { status: "stale" });
  }
}

export async function expiryTransactionGuards(db) {
  const changes = [
    (f) => capture(db, f.a.id),
    (f) => db.prepare("DELETE FROM topup_checkout_attempts WHERE id=?").bind(f.a.id).run(),
    (f) => db.prepare("DELETE FROM topup_attempt_revisions WHERE attempt_id=?").bind(f.a.id).run(),
    async (f) =>
      db
        .prepare(
          "INSERT INTO topup_claims(payment_hash,checkout_hash,state) VALUES (?,?,'deleted')",
        )
        .bind(
          await referenceHash("payment", false, "pi_late_claim"),
          await referenceHash("checkout", false, f.e.checkoutId),
        )
        .run(),
    (f) =>
      db
        .prepare("UPDATE topup_checkout_attempts SET state='open',checkout_id=? WHERE id=?")
        .bind(f.e.checkoutId, f.a.id)
        .run(),
    ...[
      ["state", "settled"],
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
  for (const change of changes) {
    const f = await fixture(db);
    const guarded = {
      prepare: (sql) => db.prepare(sql),
      batch: async (statements) => {
        await change(f);
        return db.batch(statements);
      },
    };
    assert.deepEqual(await expire(guarded, f.a, f.e), { status: "stale" });
  }
  await noPurchases(db);
}

export async function expiryRollback(db) {
  const f = await fixture(db);
  await db
    .prepare(
      "CREATE TRIGGER fixture_expiry_abort BEFORE DELETE ON topup_attempt_revisions BEGIN SELECT RAISE(ABORT,'expiry_rollback'); END",
    )
    .run();
  await assert.rejects(() => expire(db, f.a, f.e), /expiry_rollback/);
  assert.equal((await row(db, f.a.id)).state, "creating");
  assert.equal((await row(db, f.a.id)).checkout_id, null);
  assert.equal(
    (
      await db
        .prepare("SELECT revision FROM topup_attempt_revisions WHERE attempt_id=?")
        .bind(f.a.id)
        .first()
    ).revision,
    1,
  );
  await db.prepare("DROP TRIGGER fixture_expiry_abort").run();
  assert.deepEqual(await expire(db, f.a, f.e), { status: "expired" });
}
