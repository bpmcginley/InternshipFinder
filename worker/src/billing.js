// Optional "Supporter" plan over Stripe Checkout. Off until PAYMENTS_ENABLED is "1" and the Stripe
// secrets are set, so the whole feature can sit dormant in production until AI spend needs covering.
//
// What we keep: the user_hash, the Stripe customer and subscription ids, a status and the paid-through
// date. Stripe holds the card, the name and the email; they never reach this Worker or D1.
import { HttpError } from "./http.js";
import { countEvent } from "./visits.js";
import { listingEvent } from "./orders.js";
import { studentCheckout, completeStudentCheckout } from "./student-checkout.js";

const API = "https://api.stripe.com/v1/";
// The same version the webhook endpoint is set to, so events and API replies share one shape.
const STRIPE_API_VERSION = "2026-08-26.dahlia";
const ACTIVE = new Set(["active", "trialing"]);
// Stripe rejects a signature this far from its timestamp; the same window stops a replayed webhook.
const SIG_TOLERANCE_S = 300;
// 2026-10-23: isolate recovery from employer cleanup and bound combined D1/provider requests.
// Revert: remove this cron and use an independently budgeted owner-triggered reconciliation.
export const STUDENT_BILLING_CRON = "27 7 * * *";

// A paid plan is on offer only when its own Stripe Price id is set, so one tier can go live first.
export const priceIdOf = (env, config, plan) => {
  const p = config.PLANS[plan];
  return p && p.priceEnv ? env[p.priceEnv] || "" : "";
};

export const offeredPlans = (env, config) =>
  (config.PAID_PLANS || []).filter((plan) => !!priceIdOf(env, config, plan));

export const paymentsOn = (env, config) =>
  env.PAYMENTS_ENABLED === "1" && !!env.STRIPE_SECRET_KEY && (!config || offeredPlans(env, config).length > 0);

// Is there a bigger plan than the one this student is on? Drives the Upgrade button and the
// "you could raise this" wording on a cap error.
export function canUpgrade(env, config, plan = "free") {
  if (!paymentsOn(env, config)) return false;
  const mine = (config.PLANS[plan] || config.PLANS.free).multiplier;
  return offeredPlans(env, config).some((p) => config.PLANS[p].multiplier > mine);
}

// What GET /config tells the dashboard. Price text is display only; Stripe charges what the Price says.
export function paymentsInfo(env, config) {
  if (!paymentsOn(env, config)) return { enabled: false, plans: [] };
  return {
    enabled: true,
    plans: offeredPlans(env, config).map((plan) => {
      const p = config.PLANS[plan];
      return { plan, label: p.label || plan, price: (p.textEnv && env[p.textEnv]) || p.priceText, multiplier: p.multiplier };
    }),
  };
}

function need(env, config) {
  if (!paymentsOn(env, config)) throw new HttpError(404, "not_found", "Paid plans are not turned on");
}

// Exported (2026-10-19) so the paid listing orders (orders.js) make their Stripe calls through the same
// pinned version, key handling and error hiding instead of a copy.
// was: async function stripe(env, path, form, fetchImpl, idempotencyKey, method = "POST") {
export async function stripe(env, path, form, fetchImpl, idempotencyKey, method = "POST") {
  const headers = {
    Authorization: "Bearer " + env.STRIPE_SECRET_KEY,
    "Content-Type": "application/x-www-form-urlencoded",
    // Pinned, so the account's default version cannot silently change what these calls return.
    // Managed Payments needs 2025-03-31.basil or later; this matches the webhook endpoint.
    "Stripe-Version": STRIPE_API_VERSION,
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetchImpl(API + path, method === "GET" ? { method, headers } : { method, headers, body: new URLSearchParams(form).toString() });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    // Stripe's own message can name the account or the key; keep it out of the student's browser.
    console.error("stripe " + path + " failed:", res.status, data && data.error && data.error.type);
    throw new HttpError(502, "billing", "Payment service is unavailable right now. Try again later.");
  }
  return data;
}

// The plan row for one user, or the free default. Any status other than active/trialing is free.
export async function planOf(db, user) {
  const row = await db.prepare("SELECT plan, status, customer, period_end FROM plans WHERE user_hash = ?")
    .bind(user).first();
  if (!row || !ACTIVE.has(row.status)) {
    return { plan: "free", status: row ? row.status : "none", customer: row ? row.customer : null, periodEnd: null };
  }
  return { plan: row.plan, status: row.status, customer: row.customer, periodEnd: row.period_end };
}

async function savePlan(db, user, { plan, status, customer, subscription, periodEnd }, now, claim = false) {
  const r = await db.prepare(
    "INSERT INTO plans (user_hash, plan, status, customer, subscription, period_end, updated) VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(user_hash) DO UPDATE SET plan = excluded.plan, status = excluded.status, " +
    "customer = COALESCE(excluded.customer, plans.customer), subscription = COALESCE(excluded.subscription, plans.subscription), " +
    "period_end = excluded.period_end, updated = excluded.updated" + (claim
      ? " WHERE (plans.subscription IS NULL OR plans.subscription = excluded.subscription OR plans.status IN ('canceled', 'incomplete_expired')) AND NOT EXISTS (SELECT 1 FROM student_billing_recovery WHERE subscription = excluded.subscription)" : ""),
  ).bind(user, plan, status, customer || null, subscription || null, periodEnd || null, now.toISOString()).run();
  return r.meta.changes > 0;
}

const managedPayments = (env) => String(env.STRIPE_MANAGED_PAYMENTS || "") === "1";
// was: const siteUrl = (env) => ... (exported 2026-10-19 for orders.js)
export const siteUrl = (env) => (env.SITE_URL || "https://internscout.org").replace(/\/+$/, "");

// Checkout for a paid tier. client_reference_id carries the hash back on the webhook, so a
// payment can be matched to an account without Stripe ever learning who the student is.
export async function checkout(db, env, config, user, plan, now, fetchImpl) {
  need(env, config);
  plan = plan || offeredPlans(env, config)[0];
  const wanted = config.PLANS[plan];
  if (!wanted || !priceIdOf(env, config, plan)) throw new HttpError(400, "bad_plan", "No such plan");
  const existing = await planOf(db, user);
  // Moving between paid tiers is a change of subscription, which Stripe's own portal does properly
  // (with proration). Starting a second one here would bill the student twice.
  if (existing.plan !== "free") {
    throw new HttpError(409, "already", existing.plan === plan
      ? `You are already on the ${wanted.label || plan} plan.`
      : "You already have a plan. Use Manage plan to switch.");
  }
  // planOf() calls a subscription whose payment failed "free", and it is: nothing extra is granted.
  // But Stripe still holds it and is still retrying the card, so a second checkout here would leave
  // the student with two subscriptions once the retry goes through.
  if (await liveSubscription(db, user) || await billingRecoveryPending(db, user)) {
    throw new HttpError(409, "already", "Your last payment did not go through, and Stripe is still retrying it. Use Manage plan to update your card or cancel.");
  }
  const form = {
    mode: "subscription",
    "line_items[0][price]": priceIdOf(env, config, plan),
    "line_items[0][quantity]": "1",
    client_reference_id: user,
    success_url: siteUrl(env) + "/?upgraded=1",
    cancel_url: siteUrl(env) + "/",
    "subscription_data[metadata][user_hash]": user,
    "subscription_data[metadata][plan]": plan,
    allow_promotion_codes: "true",
  };
  // Stripe as merchant of record: it works out and remits sales tax/VAT for the student's country,
  // handles disputes and refunds, and needs an eligible tax code on each product. Off until Bruce
  // activates it at dashboard.stripe.com/settings/managed-payments, or Stripe rejects the session.
  if (managedPayments(env)) form["managed_payments[enabled]"] = "true";
  if (existing.customer) form.customer = existing.customer;
  return studentCheckout(db, user, plan, form, now,
    (savedForm, key) => stripe(env, "checkout/sessions", savedForm, fetchImpl, key),
    (id) => stripe(env, "checkout/sessions/" + encodeURIComponent(id), {}, fetchImpl, null, "GET"));
}

// Stripe's own page for changing or cancelling. We build no billing screens.
export async function portal(db, env, config, user, fetchImpl) {
  need(env, config);
  const row = await db.prepare("SELECT customer FROM plans WHERE user_hash = ?").bind(user).first();
  if (!row || !row.customer) throw new HttpError(404, "not_found", "No subscription to manage");
  const session = await stripe(env, "billing_portal/sessions",
                              { customer: row.customer, return_url: siteUrl(env) + "/" }, fetchImpl);
  return { url: session.url };
}

export const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// hmacHex and sameHex are exported (2026-10-19) for the signed review links of orders.js.
// was: async function hmacHex(secret, message) {
export async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

// was: const sameHex = (a, b) => {
export const sameHex = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

// Stripe-Signature: "t=<unix>,v1=<hmac of "t.body">". Anyone could POST to the webhook URL, so an
// unverified body is never allowed to change a plan.
// was: Object.fromEntries over the pairs, which kept only the last v1. While a webhook secret is
// being rolled Stripe sends one v1 per live secret, so a valid event signed with ours could be
// refused for the whole overlap. Any one matching v1 is enough.
export async function verifyWebhook(secret, header, body, now) {
  const pairs = String(header || "").split(",").map((p) => p.trim().split("=", 2));
  const t = Number((pairs.find(([k]) => k === "t") || [])[1]);
  const sigs = pairs.filter(([k, v]) => k === "v1" && v).map(([, v]) => v);
  if (!Number.isFinite(t) || !sigs.length) throw new HttpError(400, "bad_signature", "Bad webhook signature");
  if (Math.abs(Math.floor(now.getTime() / 1000) - t) > SIG_TOLERANCE_S) {
    throw new HttpError(400, "bad_signature", "Webhook timestamp is out of range");
  }
  const want = await hmacHex(secret, t + "." + body);
  if (!sigs.some((s) => sameHex(want, s))) {
    throw new HttpError(400, "bad_signature", "Bad webhook signature");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "bad_request", "Webhook body must be JSON");
  }
}

// Stripe retries, and a retry must not double-apply. Event ids are unique per event.
async function firstTime(db, id, now) {
  const r = await db.prepare("INSERT OR IGNORE INTO stripe_events (id, seen) VALUES (?, ?)")
    .bind(id, now.toISOString()).run();
  return r.meta.changes > 0;
}

// Stripe moved the renewal date off the subscription and onto its items in the 2025 API versions, so
// read whichever one this account's version sends. A missing date only blanks "renews on"; the plan
// still lives or dies by `status`.
function endOf(sub) {
  const item = sub && sub.items && Array.isArray(sub.items.data) ? sub.items.data[0] : null;
  const at = (sub && sub.current_period_end) || (item && item.current_period_end);
  return Number.isFinite(at) ? new Date(at * 1000).toISOString() : null;
}

// Turns one verified event into a plan row. Unknown event types are ignored on purpose.
// Which tier a Stripe object belongs to. Checkout stamps the plan into the subscription metadata,
// but a subscription changed inside Stripe's own portal (a student switching tiers) keeps the old
// metadata, so the price id is the more reliable answer and wins when it matches a known plan.
export function planFrom(env, config, o, fallback = "supporter") {
  const price = ((((o.items || {}).data || [])[0] || {}).price || {}).id || "";
  const byPrice = (config.PAID_PLANS || []).find((p) => price && priceIdOf(env, config, p) === price);
  if (byPrice) return byPrice;
  const named = (o.metadata || {}).plan;
  if (named && config.PLANS[named] && named !== "free") return named;
  return fallback;
}

export async function applyEvent(db, env, config, event, now, fetchImpl) {
  const id = String(event.id || crypto.randomUUID());
  if (!(await firstTime(db, id, now))) return { ok: true, repeat: true };
  try {
    return await applyFresh(db, env, config, event, now, fetchImpl);
  } catch (e) {
    // The id was recorded before the change was made. If the change then failed, forget the id, or
    // Stripe's retry would be waved through as a repeat and a student who paid would stay on free.
    await db.prepare("DELETE FROM stripe_events WHERE id = ?").bind(id).run().catch(() => {});
    throw e;
  }
}

const objectId = (value) => typeof value === "string" ? value : value && value.id;
const billingRetry = () => new HttpError(502, "billing", "Payment reconciliation is unavailable right now. Try again later.");

// 2026-10-23: was Dispute.customer (not a Stripe field), or a customer-only refund match.
// Follow the disputed/refunded payment to its invoice subscription, never a newer unrelated plan.
// Modern Stripe links payment intents via invoice_payments; older Charge.invoice is accepted too.
// Revert: remove this helper and restore the customer-only lookup in the refund/dispute branch.
async function reversedStudentPayment(db, env, event, fetchImpl) {
  const o = event.data.object;
  let charge = o;
  if (event.type === "charge.dispute.created") {
    const id = objectId(o.charge);
    if (!id) return null;
    charge = typeof o.charge === "object" && o.charge.customer !== undefined
      ? o.charge : await stripe(env, "charges/" + encodeURIComponent(id), {}, fetchImpl, null, "GET");
    if (!charge || charge.id !== id) throw billingRetry();
  }
  const customer = objectId(charge.customer);
  if (!customer) return null;
  const held = await db.prepare("SELECT user_hash, subscription FROM plans WHERE customer = ?").bind(customer).first();
  if (!held || !held.subscription) return null;
  let invoices = charge.invoice ? [charge.invoice] : [];
  if (!invoices.length) {
    const pi = objectId(charge.payment_intent) || objectId(o.payment_intent);
    if (!pi) return null; // a non-subscription/legacy charge with no resolvable payment identity
    const query = new URLSearchParams({ "payment[type]": "payment_intent", "payment[payment_intent]": pi, limit: "100" });
    const payments = await stripe(env, "invoice_payments?" + query, {}, fetchImpl, null, "GET");
    if (!payments || !Array.isArray(payments.data) || payments.has_more) throw billingRetry();
    invoices = payments.data.filter(p => objectId(p.payment && p.payment.payment_intent) === pi).map(p => p.invoice);
  }
  for (const value of invoices) {
    const id = objectId(value);
    if (!id) throw billingRetry();
    const invoice = typeof value === "object" ? value
      : await stripe(env, "invoices/" + encodeURIComponent(id), {}, fetchImpl, null, "GET");
    if (!invoice || invoice.id !== id) throw billingRetry();
    const subscription = objectId(invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription)
      || objectId(invoice.subscription);
    if (subscription === held.subscription && (!invoice.customer || objectId(invoice.customer) === customer)) {
      return { row: held, customer };
    }
  }
  return null;
}

async function applyFresh(db, env, config, event, now, fetchImpl) {
  const o = (event.data && event.data.object) || {};

  // Paid listings bought by employers (orders.js, added 2026-10-19) go first: a Checkout session whose
  // metadata.kind is "listing", and a dispute or refund on a payment that belongs to an order. They are
  // never a student's plan, and everything below is left exactly as it was. null means "not a listing".
  const listing = await listingEvent(db, env, event, now, fetchImpl);
  if (listing) return listing;
  const checkoutEvent = event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded";
  const subscriptionId = checkoutEvent ? o.subscription
    : event.type.startsWith("customer.subscription.") ? o.id : null;
  if (typeof subscriptionId === "string") {
    const recovery = await db.prepare("SELECT * FROM student_billing_recovery WHERE subscription = ?").bind(subscriptionId).first();
    if (recovery) {
      if (recovery.state !== "resolved") await recoverStudentBilling(db, env, recovery, now, fetchImpl);
      return { ok: true, reconciled: true };
    }
  }

  if (checkoutEvent) {
    const user = o.client_reference_id;
    if (!user || o.payment_status === "unpaid") return { ok: true, ignored: true };
    // The session says nothing about when the subscription renews; read that from the subscription.
    let periodEnd = null, status = "active", plan = (o.metadata || {}).plan;
    if (o.subscription) {
      // was: stripe(env, "subscriptions/" + ..., {}, fetchImpl) - with no method given that is a POST,
      // an empty UPDATE of the subscription. A restricted key with read-only Subscriptions (the right
      // key for this Worker) answers 403, the catch swallowed it, and the plan was saved "active" with
      // no renewal date and without ever looking at which price was bought.
      const sub = await stripe(env, "subscriptions/" + encodeURIComponent(o.subscription), {}, fetchImpl, null, "GET");
      if (!sub || sub.id !== o.subscription) throw new HttpError(502, "billing", "Could not confirm the paid subscription.");
      if (sub) {
        periodEnd = endOf(sub);
        status = sub.status || status;
        plan = planFrom(env, config, sub, plan);
      }
    }
    if (!plan || !config.PLANS[plan] || plan === "free") plan = (config.PAID_PLANS || ["supporter"])[0];
    if (!o.subscription) return { ok: true, ignored: true };
    // 2026-10-23: atomically retain the first live subscription, including concurrent old sessions.
    // was: every completion overwrote the only reference (W2). Revert: remove claim and recovery.
    const accepted = await savePlan(db, user, { plan, status, customer: o.customer, subscription: o.subscription, periodEnd }, now, true);
    if (!accepted) {
      await cancelStudentPlan(db, env, user, o.customer, o.subscription, "duplicate", now, fetchImpl);
      return { ok: true, reconciled: true };
    }
    await completeStudentCheckout(db, user, o.id).run();
    // The last funnel step (visits.js, added 2026-10-04): a checkout that left a plan active, counted
    // by plan. Live mode only, so Bruce's test-mode checkouts stay out of it. applyEvent() only gets
    // here for an event id it has not seen (firstTime), so a Stripe retry is not counted again, and
    // countEvent never throws, so it cannot undo the plan that was just saved.
    if (event.livemode === true && ACTIVE.has(status)) await countEvent(db, now.toISOString(), "paid", plan);
    return { ok: true };
  }

  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const user = (o.metadata && o.metadata.user_hash) ||
      (await db.prepare("SELECT user_hash FROM plans WHERE subscription = ?").bind(o.id || "").first() || {}).user_hash;
    if (!user) return { ok: true, ignored: true };
    // An event about a subscription that is not the one on file. The student's first subscription
    // ended and they bought another; a late "deleted" or "updated" for the first one (a new event id,
    // so the repeat check does not stop it) used to overwrite the row and put a paying student on free.
    const held = await db.prepare("SELECT subscription, status FROM plans WHERE user_hash = ?").bind(user).first();
    if (held && held.subscription && o.id && held.subscription !== o.id && !ENDED.has(held.status)) {
      return { ok: true, ignored: true };
    }
    // Stripe does not promise events in order, and a retried "updated: active" can land hours after
    // the "deleted" that ended the subscription, which would hand the plan back for good. So an
    // update is only a nudge: what the subscription is now is read from Stripe.
    // 2026-10-23: was fallback to the stale event during an outage, restoring canceled access.
    // Throwing leaves the plan unchanged and applyEvent releases the receipt for Stripe's retry.
    // Revert: restore catch-to-null/event fallback, accepting stale entitlements during outages.
    const live = event.type === "customer.subscription.updated" && o.id
      ? await stripe(env, "subscriptions/" + encodeURIComponent(o.id), {}, fetchImpl, null, "GET")
      : null;
    if (event.type === "customer.subscription.updated" && (!live || live.id !== o.id || !live.status)) throw billingRetry();
    const sub = live && live.id === o.id ? live : o;
    const status = event.type === "customer.subscription.deleted" ? "canceled" : (sub.status || "canceled");
    const accepted = await savePlan(db, user, {
      plan: ACTIVE.has(status) ? planFrom(env, config, sub) : "free",
      status,
      customer: sub.customer || o.customer,
      subscription: o.id,
      periodEnd: endOf(sub),
    }, now, true);
    if (!accepted && !ENDED.has(status)) await cancelStudentPlan(db, env, user, sub.customer || o.customer, o.id, "duplicate", now, fetchImpl);
    return { ok: true };
  }

  // Money taken back. Stripe cancels nothing on a refund or a dispute, so without this a student
  // who charged back or was refunded kept the bigger allowance until the subscription lapsed on its
  // own, and Managed Payments (where Stripe fights the dispute for us) is no different: the plan row
  // is ours either way. A part refund is left alone - that is a goodwill credit, not an undoing -
  // and so is a dispute that Stripe later decides in our favour, which arrives as its own event and
  // does not restore the plan; the student can subscribe again.
  if (event.type === "charge.refunded" || event.type === "charge.dispute.created") {
    if (event.type === "charge.refunded" && !(o.refunded || (o.amount_refunded && o.amount_refunded >= o.amount))) {
      return { ok: true, ignored: true };
    }
    const resolved = await reversedStudentPayment(db, env, event, fetchImpl);
    const row = resolved && resolved.row;
    if (!row || !row.user_hash) return { ok: true, ignored: true };
    await cancelStudentPlan(db, env, row.user_hash, resolved.customer, row.subscription, "refund_or_dispute", now, fetchImpl);
    return { ok: true };
  }

  return { ok: true, ignored: true };
}

// 2026-10-23: cancellation is a durable task, not a best-effort provider request (W1/W2).
// was: a failed DELETE was swallowed and the plan was marked canceled. Revert: retain unresolved rows.
export async function cancelStudentPlan(db, env, user, customer, subscription, reason, now, fetchImpl) {
  if (!subscription) throw new HttpError(502, "billing", "Missing subscription to reconcile.");
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO student_billing_recovery (subscription, user_hash, customer, reason, state, created, updated) VALUES (?, ?, ?, ?, 'cancel_pending', ?, ?)")
      .bind(subscription, user, customer || null, reason, now.toISOString(), now.toISOString()),
    db.prepare("UPDATE plans SET plan = 'free', status = 'cancel_pending', period_end = NULL, updated = ? WHERE user_hash = ? AND subscription = ? AND status NOT IN ('canceled', 'incomplete_expired')")
      .bind(now.toISOString(), user, subscription),
  ]);
  const row = await db.prepare("SELECT * FROM student_billing_recovery WHERE subscription = ?").bind(subscription).first();
  await recoverStudentBilling(db, env, row, now, fetchImpl);
}

const reconciliationError = () => new HttpError(502, "billing", "Payment reconciliation is pending. Please try again later.");

async function recoverStudentBilling(db, env, row, now, fetchImpl) {
  if (row.state === "resolved") return;
  if (row.state === "cancel_pending") {
    // Read before cancellation to retain the extra subscription's exact paid invoice, never a customer's unrelated charge.
    const before = await stripe(env, "subscriptions/" + encodeURIComponent(row.subscription), {}, fetchImpl, null, "GET");
    if (!before || before.id !== row.subscription) throw reconciliationError();
    const canceled = before.status === "canceled" ? before
      : await stripe(env, "subscriptions/" + encodeURIComponent(row.subscription), {}, fetchImpl, null, "DELETE");
    if (!canceled || canceled.id !== row.subscription || canceled.status !== "canceled") throw reconciliationError();
    const next = row.reason === "duplicate" ? "refund_pending" : "resolved";
    const invoice = row.invoice || objectId(before && before.latest_invoice) || null;
    await db.batch([
      db.prepare("UPDATE student_billing_recovery SET state = ?, invoice = ?, updated = ? WHERE subscription = ?")
        .bind(next, invoice, now.toISOString(), row.subscription),
      db.prepare("UPDATE plans SET plan = 'free', status = 'canceled', period_end = NULL, updated = ? WHERE user_hash = ? AND subscription = ?")
        .bind(now.toISOString(), row.user_hash, row.subscription),
    ]);
    row = { ...row, state: next, invoice };
  }
  if (row.state !== "refund_pending") return;
  if (!row.invoice) throw reconciliationError(); // retain a visible recovery task instead of guessing
  const invoice = await stripe(env, "invoices/" + encodeURIComponent(row.invoice), {}, fetchImpl, null, "GET");
  const invoiceSub = objectId(invoice && (invoice.subscription || invoice.parent?.subscription_details?.subscription));
  if (!invoice || invoice.id !== row.invoice || invoiceSub !== row.subscription ||
      (row.customer && objectId(invoice.customer) !== row.customer) || !Number.isSafeInteger(invoice.amount_paid)) throw reconciliationError();
  if (invoice.amount_paid > 0) {
    const payments = await stripe(env, "invoice_payments?invoice=" + encodeURIComponent(row.invoice) + "&limit=100", {}, fetchImpl, null, "GET");
    const paid = (payments?.data || []).filter(p => p.status === "paid");
    // Conservative automatic compensation: a single proven invoice payment. Anything else remains pending for owner reconciliation.
    if (payments.has_more || paid.length !== 1 || paid[0].amount_paid !== invoice.amount_paid || objectId(paid[0].invoice) !== invoice.id ||
        paid[0].payment?.type !== "payment_intent") throw reconciliationError();
    const intentId = objectId(paid[0].payment.payment_intent);
    const intent = await stripe(env, "payment_intents/" + encodeURIComponent(intentId || ""), {}, fetchImpl, null, "GET");
    if (!intent || intent.id !== intentId || intent.status !== "succeeded" || intent.amount_received !== invoice.amount_paid || intent.currency !== invoice.currency ||
        (row.customer && objectId(intent.customer) !== row.customer) || !objectId(intent.latest_charge)) throw reconciliationError();
    const chargeId = objectId(intent.latest_charge);
    const charge = await stripe(env, "charges/" + encodeURIComponent(chargeId), {}, fetchImpl, null, "GET");
    if (!charge || charge.id !== chargeId || objectId(charge.payment_intent) !== intentId || charge.amount !== invoice.amount_paid ||
        charge.currency !== invoice.currency || (row.customer && objectId(charge.customer) !== row.customer)) throw reconciliationError();
    if (!charge.refunded && charge.amount_refunded !== charge.amount) {
      // Do not infer a new amount after a partial or uncertain refund.
      if (charge.amount_refunded !== 0) throw reconciliationError();
      if (!row.refund) {
        await db.prepare("UPDATE student_billing_recovery SET refund_started = COALESCE(refund_started, ?) WHERE subscription = ?")
          .bind(now.toISOString(), row.subscription).run();
        const started = await db.prepare("SELECT refund_started FROM student_billing_recovery WHERE subscription = ?").bind(row.subscription).first();
        // A lost response must not become a new refund after Stripe has pruned its idempotency key.
        if (!started || now.getTime() - Date.parse(started.refund_started) >= 23 * 60 * 60_000) throw reconciliationError();
      }
      const refund = row.refund
        ? await stripe(env, "refunds/" + encodeURIComponent(row.refund), {}, fetchImpl, null, "GET")
        : await stripe(env, "refunds", { charge: chargeId, reason: "duplicate" }, fetchImpl, "student-duplicate-refund:" + row.subscription);
      if (!refund || !refund.id || objectId(refund.charge) !== chargeId || refund.amount !== charge.amount || refund.currency !== charge.currency) throw reconciliationError();
      await db.prepare("UPDATE student_billing_recovery SET refund = ?, updated = ? WHERE subscription = ?")
        .bind(refund.id, now.toISOString(), row.subscription).run();
      if (refund.status !== "succeeded") throw reconciliationError();
    }
  } else if (invoice.amount_paid !== 0) throw reconciliationError();
  await db.prepare("UPDATE student_billing_recovery SET state = 'resolved', updated = ? WHERE subscription = ?")
    .bind(now.toISOString(), row.subscription).run();
}

// Bounded daily retry also covers Stripe's finite webhook retry window. No customer content is logged.
export async function reconcileStudentBilling(db, env, now, fetchImpl = fetch) {
  if (!env.STRIPE_SECRET_KEY) return;
  const rows = await db.prepare("SELECT * FROM student_billing_recovery WHERE state != 'resolved' ORDER BY updated LIMIT 2").all();
  for (const row of rows.results) {
    try {
      // 2026-10-23: rotate failures too, so five manual-review refunds cannot starve cancellation.
      // was: updated changed only on successful progress. Revert: remove this attempt stamp.
      // refund_started remains unchanged: retry fairness must never reset Stripe's key-age guard.
      await db.prepare("UPDATE student_billing_recovery SET updated = ? WHERE subscription = ? AND state != 'resolved'")
        .bind(now.toISOString(), row.subscription).run();
      await recoverStudentBilling(db, env, row, now, fetchImpl);
    }
    catch { console.error("student billing reconciliation remains pending"); }
  }
}

// DELETE /me while a subscription is live would leave Stripe billing a card for an account that no
// longer exists here, so the student cancels first. Nothing is deleted behind their back.
// was: return (await planOf(db, user)).plan !== "free". planOf() reports "free" for every status but
// active and trialing, so a subscription whose renewal had failed (past_due, unpaid, incomplete) did
// not block: the row was deleted, Stripe's retry then charged the card, and the next event re-created
// a row for someone who had asked to be forgotten. What matters is whether Stripe still holds one.
export async function blocksDeletion(db, user, env, fetchImpl = fetch) {
  const { plan } = await planOf(db, user);
  if (plan !== "free" || (await liveSubscription(db, user)) || (await billingRecoveryPending(db, user))) return true;
  const pending = await db.prepare("SELECT * FROM student_checkouts WHERE user_hash = ? AND state IN ('creating', 'open')").bind(user).first();
  if (!pending) return false;
  if (pending.session && env) {
    const session = await stripe(env, "checkout/sessions/" + encodeURIComponent(pending.session), {}, fetchImpl, null, "GET");
    const subId = typeof session?.subscription === "string" ? session.subscription : session?.subscription?.id;
    const ended = session?.status === "complete" && subId && await db.prepare(
      "SELECT 1 FROM plans WHERE user_hash = ? AND subscription = ? AND status IN ('canceled', 'incomplete_expired')"
    ).bind(user, subId).first();
    if (session && session.id === pending.session && (session.status === "expired" || ended)) {
      await db.prepare("UPDATE student_checkouts SET state = ? WHERE user_hash = ? AND attempt = ? AND state IN ('creating', 'open')")
        .bind(ended ? "completed" : "expired", user, pending.attempt).run();
      return false;
    }
  }
  return true;
}

async function billingRecoveryPending(db, user) {
  return !!(await db.prepare("SELECT 1 FROM student_billing_recovery WHERE user_hash = ? AND state != 'resolved'").bind(user).first());
}

const ENDED = new Set(["canceled", "incomplete_expired"]);
async function liveSubscription(db, user) {
  const row = await db.prepare("SELECT subscription, status FROM plans WHERE user_hash = ?").bind(user).first();
  return !!(row && row.subscription && !ENDED.has(row.status));
}

export async function deletePlan(db, user) {
  await db.batch([
    db.prepare("DELETE FROM student_checkouts WHERE user_hash = ? AND state IN ('expired', 'completed')").bind(user),
    db.prepare("DELETE FROM student_billing_recovery WHERE user_hash = ? AND state = 'resolved'").bind(user),
  ]);
  await db.prepare("DELETE FROM plans WHERE user_hash = ?").bind(user).run();
}
