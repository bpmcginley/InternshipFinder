// 2026-10-23 audit: desired outcomes under provider outages, competing requests and legacy sessions.
// All provider operations are local simulations; no card, email or live Stripe request is used.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, NOW } from "./helpers.js";
import { applyEvent, checkout, blocksDeletion, reconcileStudentBilling, STUDENT_BILLING_CRON } from "../src/billing.js";
import worker from "../src/index.js";
import { readFileSync } from "node:fs";
import { CONFIG } from "../src/config.js";

const PAID = { PAYMENTS_ENABLED: "1", STRIPE_SECRET_KEY: "synthetic", STRIPE_PRICE_ID: "price_1", STRIPE_PRICE_ID_PRO: "price_pro" };
const paid = (user, id, subscription, session = "cs_legacy") => ({ id, type: "checkout.session.completed", data: { object: {
  id: session, client_reference_id: user, customer: "cus_test", subscription, payment_status: "paid",
} } });
const refund = { id: "evt_refund", type: "charge.refunded", data: { object: {
  id: "ch_sub_one", customer: "cus_test", invoice: { id: "in_sub_one", parent: { subscription_details: { subscription: "sub_one" } } },
  amount: 400, amount_refunded: 400, refunded: true,
} } };

async function fixture() {
  const sessions = new Map(), keys = new Map(), subs = new Map();
  const control = { failCancel: false, failRefund: false, lostCreate: false, failRead: false };
  const responder = (url, init = {}) => {
    const path = new URL(url).pathname.replace("/v1/", "");
    if (path === "checkout/sessions") {
      const key = init.headers["Idempotency-Key"];
      let session = keys.get(key);
      if (!session) { session = { id: "cs_" + (keys.size + 1), status: "open", url: "https://checkout.stripe.test/" + (keys.size + 1) }; keys.set(key, session); sessions.set(session.id, session); }
      if (control.lostCreate) { control.lostCreate = false; throw new TypeError("response lost"); }
      return Response.json(session);
    }
    if (path.startsWith("checkout/sessions/")) {
      if (control.failRead) return Response.json({}, { status: 503 });
      return Response.json(sessions.get(path.split("/")[2]));
    }
    if (path.startsWith("subscriptions/")) {
      const id = path.split("/")[1];
      let sub = subs.get(id);
      if (!sub) { sub = { id, status: "active", customer: "cus_test", latest_invoice: "in_" + id, items: { data: [{ price: { id: "price_1" } }] } }; subs.set(id, sub); }
      if (init.method === "DELETE") {
        if (control.failCancel) return Response.json({}, { status: 503 });
        sub.status = "canceled";
      }
      return Response.json(sub);
    }
    if (path.startsWith("invoices/")) {
      const id = path.split("/")[1], sub = id.replace("in_", "");
      return Response.json({ id, customer: "cus_test", parent: { subscription_details: { subscription: sub } }, amount_paid: 400, currency: "usd" });
    }
    if (path === "invoice_payments") {
      const invoice = new URL(url).searchParams.get("invoice"), sub = invoice.replace("in_", "");
      return Response.json({ has_more: false, data: [{ id: "ip_" + sub, invoice, status: "paid", amount_paid: 400, payment: { type: "payment_intent", payment_intent: "pi_" + sub } }] });
    }
    if (path.startsWith("payment_intents/")) {
      const id = path.split("/")[1];
      return Response.json({ id, latest_charge: id.replace("pi_", "ch_"), status: "succeeded", customer: "cus_test", amount_received: 400, currency: "usd" });
    }
    if (path.startsWith("charges/")) {
      const id = path.split("/")[1];
      return Response.json({ id, payment_intent: id.replace("ch_", "pi_"), customer: "cus_test", amount: 400, amount_refunded: 0, refunded: false, currency: "usd" });
    }
    if (path === "refunds") {
      if (control.failRefund) return Response.json({}, { status: 503 });
      const charge = new URLSearchParams(init.body).get("charge");
      return Response.json({ id: "re_duplicate", charge, amount: 400, currency: "usd", status: "succeeded" });
    }
    throw new Error("Unexpected provider route " + path);
  };
  const s = await setup({ env: PAID, stripe: responder });
  const token = await s.token(); await s.api("GET", "/me", { token });
  const user = s.db.dump().accounts[0].user_hash;
  return { ...s, token, user, control, sessions, keys, subs };
}
const buy = (s, plan = "supporter", now = NOW) => checkout(s.db, s.env, CONFIG, s.user, plan, now, s.fetch);
const event = (s, e) => applyEvent(s.db, s.env, CONFIG, e, NOW, s.fetch);

test("one account reserves one checkout across plans, simultaneous tabs and time windows", async () => {
  const s = await fixture();
  const results = await Promise.allSettled([buy(s), buy(s, "pro")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(s.keys.size, 1);
  const row = await s.db.prepare("SELECT * FROM student_checkouts").first();
  const later = new Date(NOW.getTime() + 40 * 60_000);
  assert.equal((await buy(s, row.plan, later)).url, [...s.sessions.values()][0].url);
  assert.equal(s.keys.size, 1, "a new ten-minute window must not create another payable session");
});

test("a lost creation response retries the same stored form and idempotency key", async () => {
  const s = await fixture(); s.control.lostCreate = true;
  await assert.rejects(buy(s));
  assert.ok((await buy(s)).url);
  assert.equal(s.keys.size, 1);
  const creates = s.fetch.calls.filter(c => new URL(c.url).pathname === "/v1/checkout/sessions");
  assert.equal(creates.length, 2);
  assert.equal(creates[0].init.body, creates[1].init.body);
  assert.equal(creates[0].init.headers["Idempotency-Key"], creates[1].init.headers["Idempotency-Key"]);
});

test("an uncertain creation is not retried after Stripe can prune its idempotency key", async () => {
  const s = await fixture(); s.control.lostCreate = true;
  await assert.rejects(buy(s));
  await assert.rejects(buy(s, "supporter", new Date(NOW.getTime() + 25 * 60 * 60_000)), e => e.code === "billing_reconciliation");
  assert.equal(s.keys.size, 1);
});

test("only authoritative expiry releases a reservation or permits account deletion", async () => {
  const s = await fixture(); await buy(s);
  s.control.failRead = true;
  await assert.rejects(buy(s, "pro"));
  assert.equal(s.keys.size, 1);
  s.control.failRead = false;
  assert.equal(await blocksDeletion(s.db, s.user, s.env, s.fetch), true);
  [...s.sessions.values()][0].status = "expired";
  assert.equal(await blocksDeletion(s.db, s.user, s.env, s.fetch), false);
  await buy(s, "pro");
  assert.equal(s.keys.size, 2);
});

test("failed cancellation stays durable, blocks deletion and checkout, and retries safely", async () => {
  const s = await fixture(); await event(s, paid(s.user, "evt_paid", "sub_one"));
  s.control.failCancel = true;
  await assert.rejects(event(s, refund));
  assert.equal(s.db.dump().plans[0].status, "cancel_pending");
  assert.equal(s.subs.get("sub_one").status, "active");
  assert.equal((await s.api("DELETE", "/me", { token: s.token })).status, 409);
  await assert.rejects(buy(s), e => e.status === 409);
  assert.equal(s.db.dump().stripe_events.some(r => r.id === refund.id), false, "failed webhook remains retryable");
  s.control.failCancel = false;
  await reconcileStudentBilling(s.db, s.env, NOW, s.fetch);
  assert.equal(s.db.dump().plans[0].status, "canceled");
  assert.equal(s.subs.get("sub_one").status, "canceled");
  assert.equal(await blocksDeletion(s.db, s.user, s.env, s.fetch), false);
  await event(s, refund);
  assert.equal(s.fetch.calls.filter(c => c.init.method === "DELETE").length, 2, "failed and successful calls only, no second successful cancellation");
});

test("competing legacy completions retain one plan and cancel/refund only the extra subscription", async () => {
  const s = await fixture();
  await Promise.all([event(s, paid(s.user, "evt_one", "sub_one")), event(s, paid(s.user, "evt_two", "sub_two"))]);
  assert.equal(s.db.dump().plans[0].subscription, "sub_one");
  assert.equal(s.subs.get("sub_one").status, "active");
  assert.equal(s.subs.get("sub_two").status, "canceled");
  const row = await s.db.prepare("SELECT * FROM student_billing_recovery").first();
  assert.equal(row.state, "resolved");
  assert.equal(row.subscription, "sub_two");
  const refunds = s.fetch.calls.filter(c => new URL(c.url).pathname === "/v1/refunds");
  assert.equal(refunds.length, 1);
  assert.equal(new URLSearchParams(refunds[0].init.body).get("charge"), "ch_sub_two");
});

test("duplicate refund outage remains tracked after cancellation and daily retry completes it", async () => {
  const s = await fixture(); await event(s, paid(s.user, "evt_one", "sub_one"));
  s.control.failRefund = true;
  await assert.rejects(event(s, paid(s.user, "evt_two", "sub_two")));
  assert.equal(s.db.dump().plans[0].subscription, "sub_one");
  assert.equal((await s.db.prepare("SELECT * FROM student_billing_recovery").first()).state, "refund_pending");
  s.control.failRefund = false;
  await reconcileStudentBilling(s.db, s.env, NOW, s.fetch);
  assert.equal((await s.db.prepare("SELECT * FROM student_billing_recovery").first()).state, "resolved");
  assert.equal(s.fetch.calls.filter(c => c.init.method === "DELETE").length, 1);
});

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("a delayed second subscription update cannot overwrite a checkout that claimed the plan meanwhile", async () => {
  const s = await fixture(), original = s.fetch, began = deferred(), release = deferred();
  let first = true;
  s.fetch = async (url, init = {}) => {
    if (first && new URL(url).pathname === "/v1/subscriptions/sub_two" && init.method === "GET") {
      first = false; began.resolve(); await release.promise;
    }
    return original(url, init);
  };
  const update = event(s, { id: "evt_slow_update", type: "customer.subscription.updated", data: { object: {
    id: "sub_two", status: "active", customer: "cus_test", metadata: { user_hash: s.user, plan: "supporter" },
  } } });
  await began.promise;
  await event(s, paid(s.user, "evt_first_checkout", "sub_one"));
  release.resolve(); await update;
  assert.equal(s.db.dump().plans[0].subscription, "sub_one");
  assert.equal(s.subs.get("sub_one").status, "active");
  assert.equal(s.subs.get("sub_two").status, "canceled");
  const recovery = await s.db.prepare("SELECT * FROM student_billing_recovery").first();
  assert.equal(recovery.subscription, "sub_two");
  assert.equal(recovery.state, "resolved");
});

test("a duplicate invoice that belongs to another subscription never triggers a refund", async () => {
  const s = await fixture(), original = s.fetch;
  s.fetch = async (url, init = {}) => {
    if (new URL(url).pathname === "/v1/invoices/in_sub_two") return Response.json({
      id: "in_sub_two", customer: "cus_test", subscription: "sub_one", amount_paid: 400, currency: "usd",
    });
    return original(url, init);
  };
  await event(s, paid(s.user, "evt_kept", "sub_one"));
  await assert.rejects(event(s, paid(s.user, "evt_extra", "sub_two")), e => e.status === 502);
  assert.equal(original.calls.filter(c => new URL(c.url).pathname === "/v1/refunds").length, 0);
  assert.equal(s.db.dump().plans[0].subscription, "sub_one");
  const recovery = await s.db.prepare("SELECT * FROM student_billing_recovery").first();
  assert.equal(recovery.state, "refund_pending");
  assert.equal(await blocksDeletion(s.db, s.user, s.env, original), true);
});

for (const refunded of [false, true]) test(`a lost refund response is safely reconciled after key expiry (provider refunded=${refunded})`, async () => {
  const s = await fixture(), original = s.fetch;
  let submitted = false;
  s.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/v1/refunds") {
      await original(url, init); submitted = true;
      throw new TypeError("the provider accepted the refund but its reply was lost");
    }
    if (submitted && refunded && path === "/v1/charges/ch_sub_two") return Response.json({
      id: "ch_sub_two", payment_intent: "pi_sub_two", customer: "cus_test", amount: 400,
      amount_refunded: 400, refunded: true, currency: "usd",
    });
    return original(url, init);
  };
  await event(s, paid(s.user, "evt_kept_refund", "sub_one"));
  await assert.rejects(event(s, paid(s.user, "evt_extra_refund", "sub_two")));
  let recovery = await s.db.prepare("SELECT * FROM student_billing_recovery").first();
  assert.equal(recovery.state, "refund_pending");
  assert.equal(recovery.refund, null);
  assert.ok(recovery.refund_started);
  await reconcileStudentBilling(s.db, s.env, new Date(NOW.getTime() + 25 * 60 * 60_000), s.fetch);
  recovery = await s.db.prepare("SELECT * FROM student_billing_recovery").first();
  assert.equal(original.calls.filter(c => new URL(c.url).pathname === "/v1/refunds").length, 1,
    "never create another refund with a potentially pruned idempotency key");
  assert.equal(recovery.state, refunded ? "resolved" : "refund_pending");
  assert.equal(s.db.dump().plans[0].subscription, "sub_one");
});

test("manual-review refund tasks cannot starve later pending cancellations in the bounded daily retry", async () => {
  const s = await fixture();
  for (let i = 0; i < 6; i++) {
    const at = new Date(NOW.getTime() + i * 1000).toISOString();
    await s.db.prepare("INSERT INTO student_billing_recovery (subscription, user_hash, customer, reason, state, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind("sub_backlog_" + i, s.user, "cus_test", i < 5 ? "duplicate" : "refund_or_dispute",
        i < 5 ? "refund_pending" : "cancel_pending", at, at).run();
  }
  await reconcileStudentBilling(s.db, s.env, new Date(NOW.getTime() + 86400_000), s.fetch);
  await reconcileStudentBilling(s.db, s.env, new Date(NOW.getTime() + 2 * 86400_000), s.fetch);
  await reconcileStudentBilling(s.db, s.env, new Date(NOW.getTime() + 3 * 86400_000), s.fetch);
  const late = await s.db.prepare("SELECT * FROM student_billing_recovery WHERE subscription = ?").bind("sub_backlog_5").first();
  assert.equal(late.state, "resolved", "later cancellation must be attempted even if the first five refunds need owner review");
  assert.equal(s.subs.get("sub_backlog_5")?.status, "canceled");
});

test("a full recovery batch fits its isolated invocation's combined provider and SQL budget", async () => {
  const s = await fixture();
  for (let i = 0; i < 3; i++) await s.db.prepare(
    "INSERT INTO student_billing_recovery (subscription, user_hash, customer, reason, state, created, updated) VALUES (?, ?, 'cus_test', 'duplicate', 'cancel_pending', ?, ?)"
  ).bind("sub_budget_" + i, s.user, NOW.toISOString(), NOW.toISOString()).run();
  let requests = 0;
  const wrap = statement => ({
    bind: (...args) => wrap(statement.bind(...args)),
    first: (...args) => { requests++; return statement.first(...args); },
    all: (...args) => { requests++; return statement.all(...args); },
    run: (...args) => { requests++; return statement.run(...args); },
  });
  const db = { ...s.db, prepare: sql => wrap(s.db.prepare(sql)) };
  await reconcileStudentBilling(db, s.env, NOW, (url, init) => { requests++; return s.fetch(url, init); });
  const rows = (await s.db.prepare("SELECT * FROM student_billing_recovery").all()).results;
  assert.equal(rows.filter(r => r.state === "resolved").length, 2);
  assert.ok(requests <= 40, `${requests} combined requests exceed the reserved budget`);
});

test("billing recovery has its own registered cron and never invokes unrelated daily jobs", async () => {
  const crons = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.ok(crons.includes('"' + STUDENT_BILLING_CRON + '"'));
  const waits = [];
  worker.scheduled({ cron: STUDENT_BILLING_CRON }, { DB: { prepare() { assert.fail("no Stripe key means no billing or other daily queries"); } } }, { waitUntil: p => waits.push(p) });
  assert.equal(waits.length, 1);
  await Promise.all(waits);
});
