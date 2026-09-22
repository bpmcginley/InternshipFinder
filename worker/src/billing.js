// Optional "Supporter" plan over Stripe Checkout. Off until PAYMENTS_ENABLED is "1" and the Stripe
// secrets are set, so the whole feature can sit dormant in production until AI spend needs covering.
//
// What we keep: the user_hash, the Stripe customer and subscription ids, a status and the paid-through
// date. Stripe holds the card, the name and the email; they never reach this Worker or D1.
import { HttpError } from "./http.js";

const API = "https://api.stripe.com/v1/";
// The same version the webhook endpoint is set to, so events and API replies share one shape.
const STRIPE_API_VERSION = "2026-08-26.dahlia";
const ACTIVE = new Set(["active", "trialing"]);
// Stripe rejects a signature this far from its timestamp; the same window stops a replayed webhook.
const SIG_TOLERANCE_S = 300;
// Checkouts for the same student and plan inside this window share one Stripe session.
const CHECKOUT_WINDOW_MS = 10 * 60_000;

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

async function stripe(env, path, form, fetchImpl, idempotencyKey, method = "POST") {
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

async function savePlan(db, user, { plan, status, customer, subscription, periodEnd }, now) {
  await db.prepare(
    "INSERT INTO plans (user_hash, plan, status, customer, subscription, period_end, updated) VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(user_hash) DO UPDATE SET plan = excluded.plan, status = excluded.status, " +
    "customer = COALESCE(excluded.customer, plans.customer), subscription = COALESCE(excluded.subscription, plans.subscription), " +
    "period_end = excluded.period_end, updated = excluded.updated",
  ).bind(user, plan, status, customer || null, subscription || null, periodEnd || null, now.toISOString()).run();
}

const managedPayments = (env) => String(env.STRIPE_MANAGED_PAYMENTS || "") === "1";
const siteUrl = (env) => (env.SITE_URL || "https://bpmcginley.github.io/InternshipFinder").replace(/\/+$/, "");

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
  if (await liveSubscription(db, user)) {
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
  // Two tabs (or a double click) each used to get their own session, and paying both left two
  // subscriptions with only the second on file. The same student, plan and customer within one
  // ten-minute window now get Stripe's same session back, which can only be paid once.
  const windowId = Math.floor(now.getTime() / CHECKOUT_WINDOW_MS);
  const key = ["checkout", user, plan, existing.customer || "new", windowId].join(":");
  const session = await stripe(env, "checkout/sessions", form, fetchImpl, key);
  return { url: session.url };
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

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

const sameHex = (a, b) => {
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

async function applyFresh(db, env, config, event, now, fetchImpl) {
  const o = (event.data && event.data.object) || {};

  if (event.type === "checkout.session.completed") {
    const user = o.client_reference_id;
    if (!user || o.payment_status === "unpaid") return { ok: true, ignored: true };
    // The session says nothing about when the subscription renews; read that from the subscription.
    let periodEnd = null, status = "active", plan = (o.metadata || {}).plan;
    if (o.subscription) {
      // was: stripe(env, "subscriptions/" + ..., {}, fetchImpl) - with no method given that is a POST,
      // an empty UPDATE of the subscription. A restricted key with read-only Subscriptions (the right
      // key for this Worker) answers 403, the catch swallowed it, and the plan was saved "active" with
      // no renewal date and without ever looking at which price was bought.
      const sub = await stripe(env, "subscriptions/" + encodeURIComponent(o.subscription), {}, fetchImpl, null, "GET").catch(() => null);
      if (sub) {
        periodEnd = endOf(sub);
        status = sub.status || status;
        plan = planFrom(env, config, sub, plan);
      }
    }
    if (!plan || !config.PLANS[plan] || plan === "free") plan = (config.PAID_PLANS || ["supporter"])[0];
    await savePlan(db, user, { plan, status, customer: o.customer, subscription: o.subscription, periodEnd }, now);
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
    if (held && held.subscription && o.id && held.subscription !== o.id && ACTIVE.has(held.status)) {
      return { ok: true, ignored: true };
    }
    // Stripe does not promise events in order, and a retried "updated: active" can land hours after
    // the "deleted" that ended the subscription, which would hand the plan back for good. So an
    // update is only a nudge: what the subscription is now is read from Stripe. If that read fails,
    // the event's own copy is the best we have.
    const live = event.type === "customer.subscription.updated" && o.id
      ? await stripe(env, "subscriptions/" + encodeURIComponent(o.id), {}, fetchImpl, null, "GET").catch(() => null)
      : null;
    const sub = live && live.id === o.id ? live : o;
    const status = event.type === "customer.subscription.deleted" ? "canceled" : (sub.status || "canceled");
    await savePlan(db, user, {
      plan: ACTIVE.has(status) ? planFrom(env, config, sub) : "free",
      status,
      customer: sub.customer || o.customer,
      subscription: o.id,
      periodEnd: endOf(sub),
    }, now);
    return { ok: true };
  }

  return { ok: true, ignored: true };
}

// DELETE /me while a subscription is live would leave Stripe billing a card for an account that no
// longer exists here, so the student cancels first. Nothing is deleted behind their back.
// was: return (await planOf(db, user)).plan !== "free". planOf() reports "free" for every status but
// active and trialing, so a subscription whose renewal had failed (past_due, unpaid, incomplete) did
// not block: the row was deleted, Stripe's retry then charged the card, and the next event re-created
// a row for someone who had asked to be forgotten. What matters is whether Stripe still holds one.
export async function blocksDeletion(db, user) {
  const { plan } = await planOf(db, user);
  return plan !== "free" || (await liveSubscription(db, user));
}

const ENDED = new Set(["canceled", "incomplete_expired"]);
async function liveSubscription(db, user) {
  const row = await db.prepare("SELECT subscription, status FROM plans WHERE user_hash = ?").bind(user).first();
  return !!(row && row.subscription && !ENDED.has(row.status));
}

export async function deletePlan(db, user) {
  await db.prepare("DELETE FROM plans WHERE user_hash = ?").bind(user).run();
}
