import test from "node:test";
import assert from "node:assert/strict";
import { readTopupPaymentEvidence } from "../src/topup-payment-evidence.js";
import { attempt, session, reply } from "../test-support/topup-stripe.js";
const env = { STRIPE_SECRET_KEY: "fixture-not-a-key", TOPUPS_ENABLED: "0", PAYMENTS_ENABLED: "0" };
const offer = () => ({
  version: "topup-v1",
  priceId: "price_fixture",
  amount: 300,
  currency: "usd",
  units: 25,
  livemode: false,
});
const row = () => ({ ...attempt(), state: "open", checkout_id: "cs_fixture" });
function objects() {
  const checkout = {
    ...session(),
    status: "complete",
    payment_status: "paid",
    recovered_from: null,
    payment_intent: "pi_fixture",
    url: null,
  };
  checkout.line_items.data[0].price.active = false; // historical offer, not a new-sale price
  return {
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
      client_secret: "fixture-do-not-return",
    },
    charge: {
      object: "charge",
      id: "ch_fixture",
      status: "succeeded",
      amount: 327,
      amount_captured: 327,
      captured: true,
      paid: true,
      currency: "usd",
      livemode: false,
      payment_intent: "pi_fixture",
      receipt_url: "https://example.invalid/private-receipt",
    },
  };
}
function transport(data, calls = []) {
  return async (url, options) => {
    calls.push(url);
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers["Stripe-Version"], "2026-08-26.dahlia");
    assert.equal(options.headers["Idempotency-Key"], undefined);
    if (url === "https://api.stripe.com/v1/checkout/sessions/cs_fixture?expand[]=line_items")
      return reply(data.checkout);
    if (url === "https://api.stripe.com/v1/payment_intents/pi_fixture") return reply(data.intent);
    if (url === "https://api.stripe.com/v1/charges/ch_fixture") return reply(data.charge);
    assert.fail("unexpected provider path");
  };
}
const read = (data, a = row(), config = offer(), fetch = transport(data)) =>
  readTopupPaymentEvidence(env, a, config, fetch);
test("paid evidence verifies original offer while sales are disabled and keeps tax separate", async () => {
  const data = objects(),
    calls = [];
  const result = await read(data, row(), offer(), transport(data, calls));
  assert.deepEqual(result, {
    status: "paid_evidence",
    attemptId: row().id,
    checkoutId: "cs_fixture",
    userHash: row().user_hash,
    offerVersion: "topup-v1",
    offerAmount: 300,
    currency: "usd",
    units: 25,
    livemode: false,
    paymentId: "pi_fixture",
    chargeId: "ch_fixture",
    capturedAmount: 327,
  });
  assert.equal(calls.length, 3);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(Object.hasOwn(result, "granted"), false);
});
test("provider-proven expiry is distinct from unpaid completion or a local timeout", async () => {
  const data = objects();
  data.checkout.status = "expired";
  data.checkout.payment_status = "unpaid";
  data.checkout.payment_intent = null;
  const calls = [];
  assert.equal(
    (await read(data, row(), offer(), transport(data, calls))).status,
    "expired_evidence",
  );
  assert.equal(calls.length, 1);
  data.checkout.payment_intent = "pi_fixture";
  data.intent.status = "canceled";
  data.intent.amount_received = 0;
  data.intent.latest_charge = null;
  assert.equal((await read(data)).status, "expired_evidence");
  data.intent.latest_charge = "ch_fixture";
  Object.assign(data.charge, {
    status: "failed",
    paid: false,
    captured: false,
    amount_captured: 0,
  });
  assert.equal((await read(data)).status, "expired_evidence");
  for (const patch of [
    { status: "processing" },
    { status: "succeeded" },
    { amount_received: 1 },
    { amount_capturable: 1 },
  ]) {
    assert.deepEqual(await read({ ...data, intent: { ...data.intent, ...patch } }), {
      status: "pending",
    });
  }
  data.checkout.status = "complete";
  assert.deepEqual(await read(data), { status: "pending" });
  data.checkout.status = "open";
  data.checkout.expires_at = 1;
  assert.deepEqual(await read(data, { ...row(), created: "2000-01-01T00:00:00Z" }), {
    status: "pending",
  });
});
test("lost creation can use an associated candidate but never replaces a stored identity", async () => {
  const data = objects(),
    a = { ...row(), state: "creating", checkout_id: null };
  assert.deepEqual(await read(data, a), { status: "pending" });
  assert.equal(
    (await readTopupPaymentEvidence(env, a, offer(), transport(data), "cs_fixture")).status,
    "paid_evidence",
  );
  assert.deepEqual(
    await readTopupPaymentEvidence(env, row(), offer(), () => assert.fail("no fetch"), "cs_other"),
    { status: "pending" },
  );
  assert.deepEqual(await read(data, { ...row(), state: "expired" }), { status: "pending" });
  data.checkout.status = "expired";
  data.checkout.payment_status = "unpaid";
  data.checkout.payment_intent = null;
  assert.deepEqual(await read(data, { ...row(), state: "settled" }), { status: "pending" });
});
test("all provider identity, mode, price and captured-amount mismatches remain pending", async () => {
  for (const change of [
    (d) => (d.checkout.id = "cs_other"),
    (d) => (d.checkout.mode = "subscription"),
    (d) => (d.checkout.livemode = true),
    (d) => (d.checkout.metadata.attempt_id = "other"),
    (d) => (d.checkout.client_reference_id = "b".repeat(64)),
    (d) => (d.checkout.metadata.units = "26"),
    (d) => (d.checkout.currency = "cad"),
    (d) => (d.checkout.amount_subtotal = 299),
    (d) => (d.checkout.amount_total = 328),
    (d) => (d.checkout.total_details.amount_tax = -1),
    (d) => (d.checkout.total_details.amount_discount = 1),
    (d) => (d.checkout.recovered_from = "cs_other"),
    (d) => (d.checkout.line_items.has_more = true),
    (d) => d.checkout.line_items.data.push(d.checkout.line_items.data[0]),
    (d) => (d.checkout.line_items.data[0].quantity = 2),
    (d) => (d.checkout.line_items.data[0].price.id = "price_other"),
    (d) => (d.checkout.line_items.data[0].price.tax_behavior = "inclusive"),
    (d) => (d.checkout.line_items.data = [null]),
    (d) => (d.intent.id = "pi_other"),
    (d) => (d.intent.metadata.user_hash = "b".repeat(64)),
    (d) => (d.intent.metadata.offer_version = "other"),
    (d) => (d.intent.livemode = true),
    (d) => (d.intent.currency = "cad"),
    (d) => (d.intent.amount = 326),
    (d) => (d.intent.amount_received = 0),
    (d) => (d.intent.amount_capturable = 327),
    (d) => (d.intent.status = "processing"),
    (d) => (d.intent.latest_charge = null),
    (d) => (d.charge.id = "ch_other"),
    (d) => (d.charge.payment_intent = "pi_other"),
    (d) => (d.charge.livemode = true),
    (d) => (d.charge.currency = "cad"),
    (d) => (d.charge.amount = 300),
    (d) => (d.charge.amount_captured = 300),
    (d) => (d.charge.captured = false),
    (d) => (d.charge.paid = false),
    (d) => (d.charge.status = "failed"),
  ]) {
    const data = objects();
    change(data);
    assert.deepEqual(await read(data), { status: "pending" });
  }
});
test("payment evidence neither decides refund/dispute eligibility nor trusts stale events", async () => {
  const data = objects();
  data.checkout.payment_status = "unpaid";
  assert.deepEqual(await read(data), { status: "pending" });
  data.checkout.payment_status = "paid";
  assert.equal((await read(data)).status, "paid_evidence");
  Object.assign(data.charge, { refunded: true, amount_refunded: 327, disputed: true });
  const result = await read(data);
  assert.equal(result.status, "paid_evidence");
  assert.equal(Object.hasOwn(result, "disposition"), false);
  assert.equal(Object.hasOwn(result, "refundsComplete"), false);
  assert.equal(Object.hasOwn(result, "disputesComplete"), false);
});
test("invalid configuration and failed provider reads expose no private output", async () => {
  for (const o of [
    {},
    { ...offer(), version: "wrong" },
    { ...offer(), priceId: "../bad" },
    { ...offer(), livemode: null },
  ])
    assert.deepEqual(await read(objects(), row(), o, () => assert.fail("no fetch")), {
      status: "pending",
    });
  assert.deepEqual(
    await readTopupPaymentEvidence({}, row(), offer(), () => assert.fail("no fetch")),
    { status: "pending" },
  );
  assert.deepEqual(await readTopupPaymentEvidence(env, row(), offer()), { status: "pending" });
  const original = console.error,
    logs = [];
  console.error = (...args) => logs.push(args);
  try {
    for (const fail of [
      () => {
        throw new Error("fixture-private-network");
      },
      () => ({ ok: false, text: () => assert.fail("private body must not be read") }),
      () => ({ ok: true, text: async () => "not-json-fixture-private" }),
      () => reply(null),
    ])
      assert.deepEqual(await read(objects(), row(), offer(), fail), { status: "pending" });
    assert.deepEqual(logs, []);
  } finally {
    console.error = original;
  }
});
