// Real composition and real storage; every provider response below is synthetic.
import assert from "node:assert/strict";
import { hmacHex, verifyWebhook } from "../src/billing.js";
import { recoverVerifiedTopupCheckoutEvent } from "../src/topup-checkout-events.js";
import { recoverTopupAttempt as recover } from "../src/topup-attempt-recovery.js";
import { captureTopupSettlement } from "../src/topup-first-settlement.js";
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
const now = new Date("2026-11-10T12:00:00Z");
const clock = () => now;
const rows = async (db, table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results;
async function setup(db, state = "open") {
  await db.batch(
    [
      "DROP TRIGGER IF EXISTS fixture_recovery_abort",
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
  const a = { ...attempt(), state, checkout_id: state === "creating" ? null : "cs_fixture" };
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
      state,
    )
    .run();
  const checkout = {
    ...session(a),
    status: "complete",
    payment_status: "paid",
    recovered_from: null,
    payment_intent: "pi_fixture",
    url: null,
  };
  checkout.line_items.data[0].price.active = false;
  const intent = {
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
  };
  const charge = {
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
  };
  const data = {
    a,
    checkout,
    intent,
    charge,
    refunds: [],
    disputes: [],
    calls: [],
    before: async () => {},
    alter: () => {},
  };
  data.fetch = async (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers["Stripe-Version"], "2026-08-26.dahlia");
    data.calls.push(url);
    await data.before(url);
    const path = new URL(url).pathname;
    let value;
    if (path === "/v1/checkout/sessions/cs_fixture") value = data.checkout;
    else if (path === "/v1/payment_intents/pi_fixture") value = data.intent;
    else if (path === "/v1/charges/ch_fixture") value = data.charge;
    else {
      const kind = path.slice(4);
      assert.ok(["refunds", "disputes"].includes(kind));
      assert.equal(new URL(url).searchParams.get("charge"), "ch_fixture");
      value = { object: "list", url: path, data: data[kind], has_more: false };
    }
    value = structuredClone(value);
    data.alter(value, path);
    return new Response(JSON.stringify(value));
  };
  data.run = (options = {}) => recover(db, env, a.id, offer, data.fetch, { clock, ...options });
  return data;
}
const item = (kind, status, amount = 327) => ({
  object: kind,
  id: kind === "refund" ? "re_fixture" : "du_fixture",
  charge: "ch_fixture",
  payment_intent: "pi_fixture",
  currency: "usd",
  amount,
  status,
  ...(kind === "dispute" ? { livemode: false } : {}),
});
async function noGrant(db) {
  for (const table of ["topup_claims", "topup_purchases", "topup_reconciliations"])
    assert.equal((await rows(db, table)).length, 0);
}

export async function recoveryInitialDispositions(db) {
  for (const disposition of ["available", "held", "refund", "lost"]) {
    const f = await setup(db);
    if (disposition === "refund") {
      f.refunds = [item("refund", "succeeded")];
      f.charge.amount_refunded = 327;
      f.charge.refunded = true;
    } else if (disposition !== "available") {
      f.disputes = [item("dispute", disposition === "held" ? "under_review" : "lost", 1)];
      f.charge.disputed = true;
    }
    f.before = async () => assert.equal((await rows(db, "topup_attempt_revisions"))[0].revision, 1);
    let sampled = false;
    const result = await f.run({
      clock: () => {
        sampled = true;
        assert.equal(f.calls.length, 9);
        return now;
      },
    });
    assert.equal(result.status, "settled");
    assert.equal(sampled, true);
    const expected = ["refund", "lost"].includes(disposition) ? "revoked" : disposition;
    assert.equal(result.disposition, expected);
    const p = (await rows(db, "topup_purchases"))[0];
    assert.equal(p[expected], 25);
    assert.equal(p.consumed, 0);
    assert.equal(p.amount, 327);
    assert.equal((await rows(db, "topup_checkout_attempts"))[0].state, "settled");
    assert.deepEqual(await rows(db, "topup_attempt_revisions"), []);
    const calls = f.calls.length;
    assert.deepEqual(await f.run(), { status: "inactive" });
    assert.equal(f.calls.length, calls);
  }
}

export async function recoveryExpiryAndUnknownCreation(db) {
  const f = await setup(db, "creating");
  assert.deepEqual(await f.run(), { status: "pending" });
  assert.equal(f.calls.length, 0);
  await assert.rejects(deleteUser(db, f.a.user_hash, now), { status: 409, code: "topup_payment_pending" });
  f.checkout.status = "expired";
  f.checkout.payment_status = "unpaid";
  f.checkout.payment_intent = null;
  assert.deepEqual(await f.run({ candidateCheckoutId: "cs_fixture" }), { status: "expired" });
  assert.equal(f.calls.length, 1);
  await noGrant(db);
  await deleteUser(db, f.a.user_hash, now);
  assert.deepEqual(await rows(db, "topup_checkout_attempts"), []);
  assert.deepEqual(await f.run({ candidateCheckoutId: "cs_fixture" }), { status: "inactive" });
  const paid = await setup(db, "creating");
  assert.equal((await paid.run({ candidateCheckoutId: "cs_fixture" })).status, "settled");
  assert.equal((await rows(db, "topup_checkout_attempts"))[0].checkout_id, "cs_fixture");
}

export async function recoveryRejectsAmbiguousEvidence(db) {
  const changes = [
    (v, path) => {
      if (path.includes("checkout")) v.metadata.attempt_id = crypto.randomUUID();
    },
    (v, path) => {
      if (path.includes("checkout")) v.payment_status = "unpaid";
    },
    (v, path) => {
      if (path.includes("charges")) v.id = "ch_other";
    },
    (v, path) => {
      if (path.includes("refunds")) v.has_more = true;
    },
    (v, path) => {
      if (path.includes("disputes")) v.data = [item("dispute", "unknown")];
    },
  ];
  for (const alter of changes) {
    const f = await setup(db);
    f.alter = alter;
    assert.deepEqual(await f.run(), { status: "pending" });
    await noGrant(db);
    assert.equal((await rows(db, "topup_checkout_attempts"))[0].state, "open");
  }
  for (const patch of [{ id: "ch_other" }, { livemode: true }]) {
    const changed = await setup(db);
    let charges = 0;
    changed.alter = (value, path) => {
      if (path.includes("charges") && ++charges === 2) Object.assign(value, patch);
    };
    assert.deepEqual(await changed.run(), { status: "pending" });
    assert.equal(charges, 2, "reversal identity changed after valid payment evidence");
    await noGrant(db);
  }
  const f = await setup(db);
  assert.deepEqual(await f.run({ clock: () => new Date(NaN) }), { status: "pending" });
  await noGrant(db);
  f.before = async () => {
    throw new Error("synthetic provider failure");
  };
  assert.deepEqual(await f.run(), { status: "pending" });
  await noGrant(db);
  assert.deepEqual(await recover(db, env, f.a.id, offer, null), { status: "pending" });
}

export async function recoveryRevisionAndAttachmentRaces(db) {
  for (const race of ["capture", "attachment", "remove"]) {
    const f = await setup(db);
    f.before = async () => {
      f.before = async () => {};
      if (race === "capture") await captureTopupSettlement(db, f.a.id);
      else if (race === "attachment")
        await db
          .prepare("UPDATE topup_checkout_attempts SET checkout_id='cs_new' WHERE id=?")
          .bind(f.a.id)
          .run();
      else await db.prepare("DELETE FROM topup_checkout_attempts WHERE id=?").bind(f.a.id).run();
    };
    assert.deepEqual(await f.run(), { status: "stale" });
    await noGrant(db);
  }
  const f = await setup(db);
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    started = resolve;
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
  assert.equal((await f.run()).status, "settled");
  release();
  assert.deepEqual(await older, { status: "stale" });
  assert.equal((await rows(db, "topup_purchases")).length, 1);
}

export async function recoveryRollbackAndDeletion(db) {
  const f = await setup(db);
  await db
    .prepare(
      "CREATE TRIGGER fixture_recovery_abort BEFORE INSERT ON topup_reconciliations BEGIN SELECT RAISE(ABORT,'fixture_rollback'); END",
    )
    .run();
  await assert.rejects(f.run(), /fixture_rollback/);
  await noGrant(db);
  assert.equal((await rows(db, "topup_checkout_attempts"))[0].state, "open");
  await db.prepare("DROP TRIGGER fixture_recovery_abort").run();
  assert.equal((await f.run()).status, "settled");
  await deleteUser(db, f.a.user_hash, now);
  const claims = await rows(db, "topup_claims");
  assert.equal(claims[0].state, "deleted");
  assert.deepEqual(await f.run(), { status: "inactive" });
  assert.deepEqual(await rows(db, "topup_claims"), claims);
  assert.deepEqual(await rows(db, "topup_purchases"), []);
}

async function signedCheckout(checkout, type = "checkout.session.completed") {
  const secret = crypto.randomUUID();
  const timestamp = Math.floor(+now / 1000);
  const body = JSON.stringify({ type, livemode: false, data: { object: checkout } });
  const hmac = await hmacHex(secret, `${timestamp}.${body}`);
  return verifyWebhook(secret, `t=${timestamp},v1=${hmac}`, body, now);
}

function webhook(db, f, event, overrides = {}) {
  return recoverVerifiedTopupCheckoutEvent({
    db,
    env,
    event,
    resolveOffer(version, livemode) {
      assert.equal(version, offer.version);
      assert.equal(livemode, offer.livemode);
      return offer;
    },
    fetchImpl: f.fetch,
    clock,
    ...overrides,
  });
}

export async function verifiedCheckoutRecoversLostCreationExactlyOnce(db) {
  const f = await setup(db, "creating");
  // Signed but older session facts never determine price, payment state or entitlement.
  const event = await signedCheckout({ ...f.checkout, payment_status: "unpaid", amount_total: 1 });
  assert.deepEqual(await webhook(db, f, event), { status: "settled" });
  const calls = f.calls.length;
  assert.equal(calls, 9);
  assert.equal((await rows(db, "topup_purchases"))[0].amount, 327);
  assert.equal((await rows(db, "topup_checkout_attempts"))[0].checkout_id, "cs_fixture");
  assert.deepEqual(await webhook(db, f, event), { status: "inactive" });
  assert.equal(f.calls.length, calls);
  assert.equal((await rows(db, "topup_purchases")).length, 1);

  await deleteUser(db, f.a.user_hash, now);
  assert.deepEqual(await rows(db, "topup_checkout_attempts"), []);
  assert.equal((await rows(db, "topup_claims"))[0].state, "deleted");
  const markerless = await signedCheckout({ ...f.checkout, metadata: {} });
  assert.deepEqual(await webhook(db, f, markerless), { status: "inactive" });
  assert.equal(f.calls.length, calls);
  assert.deepEqual(await rows(db, "topup_purchases"), []);
}

export async function verifiedCheckoutKnownOrAmbiguousNeverFallsThrough(db) {
  const f = await setup(db);
  const invalid = [
    { ...f.checkout, metadata: {} },
    { ...f.checkout, mode: "subscription" },
    { ...f.checkout, client_reference_id: "b".repeat(64) },
    { ...f.checkout, metadata: { ...f.checkout.metadata, units: "99" } },
    { ...f.checkout, metadata: { ...f.checkout.metadata, offer_version: "topup-other" } },
    { ...f.checkout, id: "cs_different" },
  ];
  for (const checkout of invalid)
    assert.deepEqual(await webhook(db, f, await signedCheckout(checkout)), { status: "pending" });
  const other = crypto.randomUUID();
  await db
    .prepare("INSERT INTO topup_checkout_attempts VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(
      other,
      "b".repeat(64),
      offer.version,
      300,
      "usd",
      25,
      now.toISOString(),
      "cs_other",
      "open",
    )
    .run();
  assert.deepEqual(await webhook(db, f, await signedCheckout({ ...f.checkout, id: "cs_other" })), {
    status: "pending",
  });
  assert.deepEqual(
    await webhook(
      db,
      f,
      await signedCheckout({ ...f.checkout, id: "cs_listing", metadata: { kind: "listing" } }),
    ),
    { status: "unclassified" },
  );
  assert.deepEqual(
    await webhook(
      db,
      f,
      await signedCheckout({
        ...f.checkout,
        id: "cs_subscription",
        mode: "subscription",
        metadata: {},
      }),
    ),
    { status: "unclassified" },
  );
  assert.deepEqual(
    await webhook(
      db,
      f,
      await signedCheckout({ ...f.checkout, id: "cs_unknown", metadata: {}, livemode: true }),
    ),
    { status: "pending" },
  );
  assert.deepEqual(await webhook(db, f, await signedCheckout(f.checkout, "charge.refunded")), {
    status: "unclassified",
  });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await rows(db, "topup_attempt_revisions"), []);
  await noGrant(db);

  const creating = await setup(db, "creating");
  const missingMarker = { ...creating.checkout, metadata: { attempt_id: creating.a.id } };
  assert.deepEqual(await webhook(db, creating, await signedCheckout(missingMarker)), {
    status: "pending",
  });
  for (const id of [undefined, "invalid", "cs_fixture\n"])
    assert.deepEqual(
      await webhook(db, creating, await signedCheckout({ ...missingMarker, id, metadata: {} })),
      { status: "pending" },
    );
  assert.equal(creating.calls.length, 0);
  assert.deepEqual(await rows(db, "topup_attempt_revisions"), []);
  await noGrant(db);
}

export async function verifiedCheckoutExpiryUsesAuthoritativePaymentState(db) {
  const f = await setup(db, "creating");
  const event = await signedCheckout(f.checkout, "checkout.session.expired");
  f.checkout.status = "open";
  f.checkout.payment_status = "unpaid";
  assert.deepEqual(await webhook(db, f, event), { status: "pending" });
  assert.equal((await rows(db, "topup_checkout_attempts"))[0].state, "creating");
  f.checkout.status = "expired";
  f.checkout.payment_intent = null;
  assert.deepEqual(await webhook(db, f, event), { status: "expired" });
  assert.equal((await rows(db, "topup_checkout_attempts"))[0].state, "expired");
  await noGrant(db);
}

export async function verifiedCheckoutRefreshesOnlyConfiguredModeAndCurrentAttempt(db) {
  const f = await setup(db);
  const event = await signedCheckout(f.checkout, "checkout.session.async_payment_succeeded");
  assert.deepEqual(
    await webhook(db, f, event, { resolveOffer: () => ({ ...offer, livemode: true }) }),
    {
      status: "pending",
    },
  );
  assert.equal(f.calls.length, 0);
  f.before = async () => {
    f.before = async () => {};
    await captureTopupSettlement(db, f.a.id);
  };
  assert.deepEqual(await webhook(db, f, event), { status: "pending" });
  await noGrant(db);
  assert.deepEqual(await webhook(db, f, event), { status: "settled" });
}
