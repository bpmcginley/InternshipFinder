// 2026-10-23 audit: documented Dispute has charge/payment_intent, never direct customer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvent } from "../src/billing.js";
import { CONFIG } from "../src/config.js";
import { fakeD1, NOW } from "./helpers.js";

const env = { STRIPE_SECRET_KEY: "test", STRIPE_PRICE_ID: "price_1" };
async function held(status = "active") {
  const db = fakeD1();
  await db.prepare("INSERT INTO plans (user_hash, plan, status, customer, subscription, updated) VALUES (?, ?, ?, ?, ?, ?)")
    .bind("user", status === "active" ? "supporter" : "free", status, "cus_1", "sub_1", NOW.toISOString()).run();
  return db;
}
const dispute = { id: "evt_dispute", type: "charge.dispute.created", data: { object: {
  id: "du_1", object: "dispute", charge: "ch_1", payment_intent: "pi_1", amount: 500, status: "needs_response",
} } };
const invoice = (subscription = "sub_1") => ({ id: "in_1", object: "invoice", customer: "cus_1",
  parent: { type: "subscription_details", subscription_details: { subscription } } });
function provider({ failure = "", sub = "sub_1", invoiceObject = invoice(sub), modern = true } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ url: String(url), method: init.method });
    if (path.endsWith(failure) && failure) return Response.json({ error: { type: "api_error" } }, { status: 503 });
    if (path === "/v1/charges/ch_1") return Response.json({ id: "ch_1", object: "charge", customer: "cus_1",
      payment_intent: "pi_1", ...(modern ? {} : { invoice: "in_1" }) });
    if (path === "/v1/invoice_payments") {
      const q = new URL(url).searchParams;
      assert.equal(q.get("payment[type]"), "payment_intent");
      assert.equal(q.get("payment[payment_intent]"), "pi_1");
      return Response.json({ object: "list", has_more: false, data: [
        { id: "inpay_1", object: "invoice_payment", invoice: "in_1", payment: { type: "payment_intent", payment_intent: "pi_1" } },
      ] });
    }
    if (path === "/v1/invoices/in_1") return Response.json(invoiceObject);
    if (path === "/v1/subscriptions/sub_1" && init.method === "DELETE") return Response.json({ id: "sub_1", status: "canceled" });
    if (path === "/v1/subscriptions/sub_1" && init.method === "GET") return Response.json({ id: "sub_1", status: "active" });
    throw new Error("Unexpected provider call " + init.method + " " + path);
  };
  return { fetch, calls };
}

test("realistic disputes resolve modern invoice payment to exactly the held subscription", async () => {
  const db = await held(), p = provider();
  assert.deepEqual(await applyEvent(db, env, CONFIG, dispute, NOW, p.fetch), { ok: true });
  assert.equal((await db.dump()).plans[0].status, "canceled");
  assert.equal(p.calls.filter(c => c.method === "DELETE").length, 1);
  assert.deepEqual(await applyEvent(db, env, CONFIG, dispute, NOW, p.fetch), { ok: true, repeat: true });
  assert.equal(p.calls.filter(c => c.method === "DELETE").length, 1);
});

test("legacy charge.invoice and expanded invoice objects resolve without customer-only guesses", async () => {
  for (const invoiceObject of [invoice(), { id: "in_1", customer: "cus_1", subscription: "sub_1" }]) {
    const db = await held(), p = provider({ modern: false, invoiceObject });
    await applyEvent(db, env, CONFIG, dispute, NOW, p.fetch);
    assert.equal((await db.dump()).plans[0].status, "canceled");
  }
});

test("a dispute for an old subscription never cancels the newer student subscription", async () => {
  const db = await held(), p = provider({ sub: "sub_old" });
  assert.equal((await applyEvent(db, env, CONFIG, dispute, NOW, p.fetch)).ignored, true);
  assert.equal((await db.dump()).plans[0].status, "active");
  assert.equal(p.calls.filter(c => c.method === "DELETE").length, 0);
});

test("a one-time payment with the same customer does not cancel a student plan", async () => {
  const db = await held(), p = provider({ invoiceObject: { id: "in_1", customer: "cus_1", parent: null } });
  assert.equal((await applyEvent(db, env, CONFIG, dispute, NOW, p.fetch)).ignored, true);
  assert.equal((await db.dump()).plans[0].status, "active");
});

test("failed charge/invoice-payment/invoice reads retain entitlement and retry the event", async () => {
  for (const failure of ["/charges/ch_1", "/invoice_payments", "/invoices/in_1"]) {
    const db = await held();
    await assert.rejects(applyEvent(db, env, CONFIG, dispute, NOW, provider({ failure }).fetch), e => e.status === 502);
    assert.equal((await db.dump()).plans[0].status, "active");
    assert.equal((await db.dump()).stripe_events.length, 0);
    await applyEvent(db, env, CONFIG, dispute, NOW, provider().fetch);
    assert.equal((await db.dump()).plans[0].status, "canceled");
  }
});

test("full refund resolves expanded invoice and partial refund does not perform cancellation", async () => {
  for (const amount_refunded of [200, 500]) {
    const db = await held(), p = provider();
    const event = { id: "evt_refund", type: "charge.refunded", data: { object: {
      id: "ch_1", customer: "cus_1", amount: 500, amount_refunded, invoice: invoice(),
    } } };
    await applyEvent(db, env, CONFIG, event, NOW, p.fetch);
    assert.equal((await db.dump()).plans[0].status, amount_refunded === 500 ? "canceled" : "active");
    assert.equal(p.calls.length, amount_refunded === 500 ? 2 : 0);
  }
});

test("stale active event during Stripe outage cannot restore canceled entitlement; retry reconciles", async () => {
  const db = await held("canceled");
  const event = { id: "evt_stale", type: "customer.subscription.updated", data: { object: {
    id: "sub_1", customer: "cus_1", status: "active", metadata: { user_hash: "user" },
  } } };
  await assert.rejects(applyEvent(db, env, CONFIG, event, NOW, async () => Response.json({ error: { type: "api_error" } }, { status: 503 })), e => e.status === 502);
  assert.equal((await db.dump()).plans[0].status, "canceled");
  assert.equal((await db.dump()).stripe_events.length, 0);
  await applyEvent(db, env, CONFIG, event, NOW, async () => Response.json({ id: "sub_1", status: "canceled", customer: "cus_1" }));
  assert.equal((await db.dump()).plans[0].status, "canceled");
  assert.equal((await db.dump()).stripe_events.length, 1);
});
