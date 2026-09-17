// Optional "Supporter" plan over Stripe Checkout. Off until PAYMENTS_ENABLED is "1" and the Stripe
// secrets are set, so the whole feature can sit dormant in production until AI spend needs covering.
//
// What we keep: the user_hash, the Stripe customer and subscription ids, a status and the paid-through
// date. Stripe holds the card, the name and the email; they never reach this Worker or D1.
import { HttpError } from "./http.js";

const API = "https://api.stripe.com/v1/";
const ACTIVE = new Set(["active", "trialing"]);
// Stripe rejects a signature this far from its timestamp; the same window stops a replayed webhook.
const SIG_TOLERANCE_S = 300;

export const paymentsOn = (env) =>
  env.PAYMENTS_ENABLED === "1" && !!env.STRIPE_SECRET_KEY && !!env.STRIPE_PRICE_ID;

// What GET /config tells the dashboard. Price text is display only; Stripe charges what the price says.
export function paymentsInfo(env, config) {
  if (!paymentsOn(env)) return { enabled: false };
  return {
    enabled: true,
    price: env.SUPPORTER_PRICE_TEXT || config.PLANS.supporter.priceText,
    multiplier: config.PLANS.supporter.multiplier,
  };
}

function need(env) {
  if (!paymentsOn(env)) throw new HttpError(404, "not_found", "Supporter plans are not turned on");
}

async function stripe(env, path, form, fetchImpl, idempotencyKey) {
  const headers = {
    Authorization: "Bearer " + env.STRIPE_SECRET_KEY,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetchImpl(API + path, { method: "POST", headers, body: new URLSearchParams(form).toString() });
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

const siteUrl = (env) => (env.SITE_URL || "https://bpmcginley.github.io/InternshipFinder").replace(/\/+$/, "");

// Checkout for the Supporter plan. client_reference_id carries the hash back on the webhook, so a
// payment can be matched to an account without Stripe ever learning who the student is.
export async function checkout(db, env, user, now, fetchImpl) {
  need(env);
  const existing = await planOf(db, user);
  if (existing.plan === "supporter") {
    throw new HttpError(409, "already", "You are already on the Supporter plan.");
  }
  const form = {
    mode: "subscription",
    "line_items[0][price]": env.STRIPE_PRICE_ID,
    "line_items[0][quantity]": "1",
    client_reference_id: user,
    success_url: siteUrl(env) + "/?upgraded=1",
    cancel_url: siteUrl(env) + "/",
    "subscription_data[metadata][user_hash]": user,
    allow_promotion_codes: "true",
  };
  if (existing.customer) form.customer = existing.customer;
  const session = await stripe(env, "checkout/sessions", form, fetchImpl);
  return { url: session.url };
}

// Stripe's own page for changing or cancelling. We build no billing screens.
export async function portal(db, env, user, fetchImpl) {
  need(env);
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
export async function verifyWebhook(secret, header, body, now) {
  const parts = Object.fromEntries(String(header || "").split(",").map((p) => p.split("=", 2)));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) throw new HttpError(400, "bad_signature", "Bad webhook signature");
  if (Math.abs(Math.floor(now.getTime() / 1000) - t) > SIG_TOLERANCE_S) {
    throw new HttpError(400, "bad_signature", "Webhook timestamp is out of range");
  }
  if (!sameHex(await hmacHex(secret, t + "." + body), parts.v1)) {
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
export async function applyEvent(db, env, event, now, fetchImpl) {
  if (!(await firstTime(db, String(event.id || crypto.randomUUID()), now))) return { ok: true, repeat: true };
  const o = (event.data && event.data.object) || {};

  if (event.type === "checkout.session.completed") {
    const user = o.client_reference_id;
    if (!user || o.payment_status === "unpaid") return { ok: true, ignored: true };
    // The session says nothing about when the subscription renews; read that from the subscription.
    let periodEnd = null, status = "active";
    if (o.subscription) {
      const sub = await stripe(env, "subscriptions/" + encodeURIComponent(o.subscription), {}, fetchImpl).catch(() => null);
      if (sub) {
        periodEnd = endOf(sub);
        status = sub.status || status;
      }
    }
    await savePlan(db, user, { plan: "supporter", status, customer: o.customer, subscription: o.subscription, periodEnd }, now);
    return { ok: true };
  }

  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const user = (o.metadata && o.metadata.user_hash) ||
      (await db.prepare("SELECT user_hash FROM plans WHERE subscription = ?").bind(o.id || "").first() || {}).user_hash;
    if (!user) return { ok: true, ignored: true };
    const status = event.type === "customer.subscription.deleted" ? "canceled" : (o.status || "canceled");
    await savePlan(db, user, {
      plan: ACTIVE.has(status) ? "supporter" : "free",
      status,
      customer: o.customer,
      subscription: o.id,
      periodEnd: endOf(o),
    }, now);
    return { ok: true };
  }

  return { ok: true, ignored: true };
}

// DELETE /me while a subscription is live would leave Stripe billing a card for an account that no
// longer exists here, so the student cancels first. Nothing is deleted behind their back.
export async function blocksDeletion(db, user) {
  const { plan } = await planOf(db, user);
  return plan !== "free";
}

export async function deletePlan(db, user) {
  await db.prepare("DELETE FROM plans WHERE user_hash = ?").bind(user).run();
}
