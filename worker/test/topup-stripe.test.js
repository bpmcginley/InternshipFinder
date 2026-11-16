import test from "node:test";
import assert from "node:assert/strict";
import { fakeD1 } from "./helpers.js";
import { prepareTopupStripe } from "../src/topup-stripe.js";
import { reserveTopupCheckout } from "../src/topup-checkout.js";
import {
  env,
  callbacks,
  attempt,
  price,
  session,
  reply,
  stripeReservationRoundTrip,
} from "../test-support/topup-stripe.js";
const unavailable = { message: "Top-up checkout is unavailable" };
test("top-up Stripe round trip keeps only the checkout identity", () =>
  stripeReservationRoundTrip(fakeD1()));
test("disabled or invalid local configuration cannot fetch or reserve", async () => {
  for (const config of [
    undefined,
    {},
    { ...env, TOPUPS_ENABLED: "0" },
    { ...env, PAYMENTS_ENABLED: "0" },
    { ...env, STRIPE_SECRET_KEY: "" },
    { ...env, STRIPE_PRICE_TOPUP: "" },
    { ...env, STRIPE_PRICE_TOPUP: "../fixture" },
    { ...env, SITE_URL: "http://example.invalid" },
  ]) {
    assert.deepEqual(
      await prepareTopupStripe(config, callbacks, () => assert.fail("must not fetch")),
      { enabled: false },
    );
  }
  assert.deepEqual(await prepareTopupStripe(env, callbacks), { enabled: false });
  for (const success of [
    "https://other.invalid/",
    "https://example.invalid@other.invalid/",
    "http://example.invalid/",
    "https://example.invalid/#token",
    "https://example.invalid/\\evil",
    "not a URL",
  ]) {
    assert.deepEqual(
      await prepareTopupStripe(env, { ...callbacks, success }, () => assert.fail("must not fetch")),
      { enabled: false },
    );
  }
});
test("only the dedicated active fixed one-time USD exclusive-tax price enables", async () => {
  for (const change of [
    (p) => (p.id = "price_other"),
    (p) => (p.active = false),
    (p) => (p.type = "recurring"),
    (p) => (p.recurring = {}),
    (p) => (p.billing_scheme = "tiered"),
    (p) => (p.custom_unit_amount = {}),
    (p) => (p.transform_quantity = {}),
    (p) => (p.currency = "cad"),
    (p) => (p.unit_amount = 301),
    (p) => (p.unit_amount_decimal = "300.1"),
    (p) => (p.tax_behavior = "inclusive"),
    (p) => (p.tax_behavior = "unspecified"),
    (p) => (p.livemode = null),
    (p) => (p.product.active = false),
    (p) => (p.product.deleted = true),
    (p) => (p.product = "prod_unexpanded"),
  ]) {
    const p = price();
    change(p);
    const cap = await prepareTopupStripe(env, callbacks, async () => reply(p));
    assert.equal(cap.enabled, false);
    assert.equal((await reserveTopupCheckout(null, "a".repeat(64), cap)).status, "disabled");
  }
});
test("manual multi-currency prices pin USD and reject non-USD replies", async () => {
  const multi = {
    ...price(),
    currency_options: { usd: { unit_amount: 300 }, cad: { unit_amount: 450 } },
  };
  let returnedCurrency = "usd",
    posts = 0;
  const cap = await prepareTopupStripe(env, callbacks, async (url, options) => {
    if (url.includes("/prices/")) return reply(multi);
    if (options.method === "POST") {
      posts++;
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("currency"), "usd");
      assert.equal(form.get("adaptive_pricing[enabled]"), "false");
    }
    return reply({ ...session(), currency: returnedCurrency });
  });
  assert.equal(cap.enabled, true);
  assert.equal((await cap.create(attempt())).currency, "usd");
  returnedCurrency = "cad";
  await assert.rejects(cap.create(attempt()), unavailable);
  await assert.rejects(
    cap.readOpen({ ...attempt(), state: "open", checkout_id: "cs_fixture" }),
    unavailable,
  );
  assert.equal(posts, 2);
});
test("Managed Payments keeps USD verification and leaves Adaptive Pricing to Stripe", async () => {
  let form;
  const cap = await prepareTopupStripe(
    { ...env, STRIPE_MANAGED_PAYMENTS: "1" },
    callbacks,
    async (url, options) => {
      if (url.includes("/prices/")) return reply(price());
      form = new URLSearchParams(options.body);
      return reply(session());
    },
  );
  assert.equal(cap.enabled, true);
  assert.equal((await cap.create(attempt())).units, 25);
  assert.equal(form.get("managed_payments[enabled]"), "true");
  assert.equal(form.has("adaptive_pricing[enabled]"), false);
  assert.equal(form.get("currency"), "usd");
});
test("creation and retrieval fail closed on mismatched identity, contents or URL", async () => {
  for (const change of [
    (s) => (s.mode = "subscription"),
    (s) => (s.id = "../bad"),
    (s) => (s.ui_mode = "embedded_page"),
    (s) => (s.status = "complete"),
    (s) => (s.payment_status = "paid"),
    (s) => (s.livemode = true),
    (s) => (s.client_reference_id = "b".repeat(64)),
    (s) => (s.metadata.attempt_id = "other"),
    (s) => (s.metadata.user_hash = "b".repeat(64)),
    (s) => (s.metadata.offer_version = "other"),
    (s) => (s.metadata.units = "26"),
    (s) => (s.amount_subtotal = 299),
    (s) => (s.currency = "cad"),
    (s) => (s.success_url += "x"),
    (s) => (s.line_items = null),
    (s) => (s.line_items.data = [null]),
    (s) => (s.line_items.has_more = true),
    (s) => s.line_items.data.push(s.line_items.data[0]),
    (s) => (s.line_items.data[0].quantity = 2),
    (s) => (s.line_items.data[0].price.id = "price_other"),
    (s) => (s.total_details.amount_discount = 1),
    (s) => (s.total_details.amount_tax = -1),
    (s) => (s.amount_total = 300),
    ...[
      "https://checkout.stripe.com.evil.invalid/c/pay/cs_fixture",
      "https://attacker@checkout.stripe.com/c/pay/cs_fixture",
      "http://checkout.stripe.com/c/pay/cs_fixture",
      "https://checkout.stripe.com/c/pay/cs_other",
      "fixture-private-invalid-url",
    ].map((url) => (s) => (s.url = url)),
  ]) {
    const s = session();
    change(s);
    const cap = await prepareTopupStripe(env, callbacks, async (url) =>
      reply(url.includes("/prices/") ? price() : s),
    );
    await assert.rejects(cap.create(attempt()), unavailable);
    await assert.rejects(
      cap.readOpen({ ...attempt(), state: "open", checkout_id: "cs_fixture" }),
      unavailable,
    );
  }
});
test("invalid durable attempts cannot invoke provider; provider failures stay anonymous and pending", async () => {
  const cap = await prepareTopupStripe(env, callbacks, async (url) => {
    if (url.includes("/prices/")) return reply(price());
    assert.fail("must not invoke provider");
  });
  for (const patch of [
    { offer_version: "other" },
    { idempotencyKey: "other" },
    { state: "open" },
    { checkout_id: "cs_fixture" },
    { units: 24 },
    { user_hash: "bad" },
  ])
    await assert.rejects(cap.create({ ...attempt(), ...patch }), unavailable);
  await assert.rejects(cap.readOpen(attempt()), unavailable);
  const logged = [],
    original = console.error;
  console.error = (...args) => logged.push(args);
  try {
    for (const failure of [
      () => {
        throw new Error("fixture-private-provider-error");
      },
      () => ({ ok: false, status: 500, text: () => assert.fail("must not read private error") }),
      () => ({
        ok: true,
        text: () => {
          throw new Error("fixture-private-body-error");
        },
      }),
    ]) {
      const broken = await prepareTopupStripe(env, callbacks, async (url) =>
        url.includes("/prices/") ? reply(price()) : failure(),
      );
      await assert.rejects(broken.create(attempt()), unavailable);
      const db = fakeD1();
      assert.equal((await reserveTopupCheckout(db, "a".repeat(64), broken)).status, "pending");
      assert.equal(
        await db.prepare("SELECT checkout_id FROM topup_checkout_attempts").first("checkout_id"),
        null,
      );
    }
    assert.deepEqual(logged, []);
  } finally {
    console.error = original;
  }
});
