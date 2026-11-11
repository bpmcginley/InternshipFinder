import assert from "node:assert/strict";
import { prepareTopupStripe } from "../src/topup-stripe.js";
import { reserveTopupCheckout } from "../src/topup-checkout.js";
export const env = {
  TOPUPS_ENABLED: "1",
  PAYMENTS_ENABLED: "1",
  STRIPE_SECRET_KEY: "fixture-not-a-key",
  STRIPE_PRICE_TOPUP: "price_fixture",
  SITE_URL: "https://example.invalid",
};
export const callbacks = {
  success: "https://example.invalid/?done=1",
  cancel: "https://example.invalid/?cancel=1",
};
export const attempt = () => ({
  id: "11111111-1111-4111-8111-111111111111",
  user_hash: "a".repeat(64),
  offer_version: "topup-v1",
  amount: 300,
  currency: "usd",
  units: 25,
  state: "creating",
  checkout_id: null,
  idempotencyKey: "topup-checkout:11111111-1111-4111-8111-111111111111",
});
export const price = () => ({
  object: "price",
  id: env.STRIPE_PRICE_TOPUP,
  active: true,
  type: "one_time",
  billing_scheme: "per_unit",
  recurring: null,
  custom_unit_amount: null,
  transform_quantity: null,
  currency: "usd",
  unit_amount: 300,
  unit_amount_decimal: "300",
  tax_behavior: "exclusive",
  livemode: false,
  product: { object: "product", active: true },
});
export function session(a = attempt()) {
  return {
    object: "checkout.session",
    id: "cs_fixture",
    mode: "payment",
    ui_mode: "hosted_page",
    status: "open",
    payment_status: "unpaid",
    livemode: false,
    client_reference_id: a.user_hash,
    currency: "usd",
    amount_subtotal: 300,
    amount_total: 327,
    success_url: callbacks.success,
    cancel_url: callbacks.cancel,
    metadata: {
      kind: "autofill_topup",
      attempt_id: a.id,
      user_hash: a.user_hash,
      offer_version: a.offer_version,
      units: "25",
    },
    line_items: {
      object: "list",
      has_more: false,
      data: [{ quantity: 1, price: price(), amount_subtotal: 300, currency: "usd" }],
    },
    total_details: { amount_tax: 27, amount_discount: 0, amount_shipping: 0 },
    url: "https://checkout.stripe.com/c/pay/cs_fixture#ephemeral-fixture",
  };
}
export const reply = (value) => new Response(JSON.stringify(value));
export async function stripeReservationRoundTrip(db) {
  let posts = 0,
    reads = 0,
    current;
  const adapter = await prepareTopupStripe(env, callbacks, async (url, options) => {
    assert.equal(options.headers["Stripe-Version"], "2026-08-26.dahlia");
    assert.equal(options.redirect, "manual");
    if (url.includes("/prices/")) return reply(price());
    if (options.method === "POST") {
      posts++;
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("line_items[0][quantity]"), "1");
      assert.equal(form.get("line_items[0][price]"), env.STRIPE_PRICE_TOPUP);
      assert.equal(form.get("mode"), "payment");
      assert.equal(form.get("ui_mode"), "hosted_page");
      assert.equal(form.get("currency"), "usd");
      assert.equal(form.get("adaptive_pricing[enabled]"), "false");
      const id = form.get("metadata[attempt_id]");
      assert.equal(options.headers["Idempotency-Key"], "topup-checkout:" + id);
      assert.equal(form.get("payment_intent_data[metadata][attempt_id]"), id);
      assert.equal(form.get("payment_intent_data[metadata][user_hash]"), "a".repeat(64));
      for (const key of [
        "customer",
        "customer_email",
        "allow_promotion_codes",
        "managed_payments[enabled]",
      ])
        assert.equal(form.has(key), false);
      current = session({ ...attempt(), id });
    } else {
      reads++;
      assert.match(url, /checkout\/sessions\/cs_fixture\?expand\[\]=line_items$/);
    }
    return reply(current);
  });
  const results = await Promise.all(
    Array.from({ length: 5 }, () => reserveTopupCheckout(db, "a".repeat(64), adapter)),
  );
  assert.equal(posts, 1);
  assert.equal(new Set(results.map((r) => r.attempt.id)).size, 1);
  const replay = await reserveTopupCheckout(db, "a".repeat(64), adapter);
  assert.equal(replay.status, "open");
  assert.equal((await adapter.readOpen(replay.attempt)).url, current.url);
  assert.equal(reads, 1);
  assert.equal(posts, 1);
  const row = await db.prepare("SELECT * FROM topup_checkout_attempts").first();
  assert.equal(row.checkout_id, "cs_fixture");
  assert.equal(JSON.stringify(row).includes("ephemeral-fixture"), false);
  assert.equal(
    Object.keys(row).some((k) => /url|secret|price/i.test(k)),
    false,
  );
}
