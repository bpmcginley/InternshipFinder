// Self-serve paid listing orders (added 2026-10-19). The design, the reasons and how to turn it on:
// worker/ORDERS.md. Contract: API.md "Paid listing orders".
//
// An employer picks 1 or 3 of its open roles on internscout.org/employers/buy/, confirms a work email,
// pays through Stripe Checkout (or uses a pilot code) and Bruce makes one decision per order from a
// signed link in his email: Approve or Refuse. Approving drives the same placement steps Bruce runs by
// hand (placements.js: update, check, on), so every rule there still holds and every step is logged.
//
// What this file adds and nothing else does:
// - the role index check: a role qualifies only if the site's own role index lists it as open today,
//   read from SITE_URL, so a buyer can't name a role, link or field we don't list;
// - the per-field cap (FIELD_CAP paid roles at once per field tag) instead of any bidding;
// - the email link (a random token, stored only as its SHA-256), and the emails themselves (mail.js);
// - the Stripe calls for a one-off payment, a refund and a credit (billing.js's request helper);
// - the daily cron: dropping unconfirmed orders, resending review emails, closing roles that are gone
//   and the credit-or-refund offer for their unused days.
//
// Off until ordersOn(env). While off every /employer/* route answers 404, except GET /employer/config,
// which says enabled: false so the buy page can say buying on the site is not open yet.
import { HttpError } from "./http.js";
import { bumpUnder } from "./limits.js";
import { EMAIL, isBot } from "./leads.js";
import { CHECKS, addDays, checkPlacement, createPlacement, dayOf, daysBetween, endPlacement, pausePlacement,
  refusePlacement, switchOn, updatePlacement } from "./placements.js";
import { hex, sameHex, siteUrl, stripe } from "./billing.js";
import { trySend, sendMail } from "./mail.js";
import { queueOrderMail, retryOrderMail, dropRetainedOrders } from "./order-mail.js";
import { CHECKOUT_HOLD_MS, CREDIT_DEFAULT_DAYS, DAYS, FIELD_CAP, LIMITS, LISTING_ID, MAX_START_DAYS, UNVERIFIED_DAYS, bad, conflict, fieldsOf, money, rolesWord, text } from "./orders/shared.js";
import { readShard, shardOf } from "./orders/roles.js";
import { busiest, fillPlacementFields, firstFit, fitAll, heldRoles, reserveCapacity, startDay } from "./orders/capacity.js";
import { approvedMail, closedMail, creditMail, receivedMail, refusedMail, reviewMail, reviewSig, verifyMail } from "./orders/templates.js";

export { listOrders } from "./orders/admin.js";
export { PILOT_MAX, createPilotCode } from "./orders/pilot.js";
export { readShard, shardOf } from "./orders/roles.js";
export { availability, notePlacementFields } from "./orders/capacity.js";
export { CREDIT_DEFAULT_DAYS, DAYS, FIELD_CAP, MAX_START_DAYS, UNVERIFIED_DAYS } from "./orders/shared.js";
export { TERMS_ARCHIVE, reviewSig } from "./orders/templates.js";

// Prices in cents (Bruce, 2026-10-19: final). public_body is the price for a nonprofit or public body.
export const PRICES = {
  one: { roles: 1, cents: 2900, public_body_cents: 1500 },
  three: { roles: 3, cents: 6900, public_body_cents: 3500 },
};
export const TOKEN_HOURS = 48;       // the email link works this long
// The terms an order accepts: docs/terms.html's "Last updated" day (tests/site/buy.test.mjs holds the two
// together), and the clickwrap box exactly as docs/employers/buy/ shows it, stored on every order (legal
// review round 4, 2026-10-19). was: "2026-10-19", and only the version was stored.
export const TERMS_VERSION = "2026-10-20";
export const TERMS_BOX = "I have read and accept the InternScout terms, including the section for employers, on behalf of my company, and I am authorized to accept them for it.";
export const MAX_ORDER_BYTES = 4_000;
export const MAX_FORM_BYTES = 4_000;

const CHECKOUT_EXPIRES_S = 31 * 60;
// A Checkout opened this recently is handed out again rather than opening a second one.
const CHECKOUT_REUSE_MS = 30 * 60_000;
const REMIND_AFTER_MS = 24 * 3600e3;
// Orders per network address per UTC day, and from everyone, like the interest form (leads.js).
export const PER_ADDRESS_PER_DAY = 5;
export const ALL_PER_DAY = 100;
const ALL = "order:*";

// The site build drops a placement for these reasons when its role has gone (placement_runs.reason).
export const CLOSE_REASONS = ["listing_gone", "closed", "url_changed", "deadline"];

// Free webmail domains. The terms say "you write from your company's domain".
export const WEBMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com",
  "yahoo.com", "yahoo.co.uk", "ymail.com", "rocketmail.com", "aol.com", "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "gmx.de", "web.de", "mail.com", "zoho.com",
  "zohomail.com", "yandex.com", "yandex.ru", "tutanota.com", "tuta.io", "fastmail.com", "hey.com", "qq.com",
  "163.com", "126.com", "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "duck.com",
]);

// Only the site's own pages send the order, confirm and credit choice (a browser always sets Origin).
const SITE = /^https:\/\/(internscout\.org|bpmcginley\.github\.io)$/;
const ORDER_ID = /^o-[0-9a-f]{16}$/;
const CREDIT_ID = /^c-[0-9a-f]{16}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PILOT = /^[A-Z0-9-]{4,32}$/;

const notFound = () => new HttpError(404, "not_found", "No such endpoint");

// ---------------------------------------------------------------- on or off

export const ordersOn = (env) =>
  env.EMPLOYER_CHECKOUT === "1" && !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET && !!env.ADMIN_TOKEN &&
  !!env.REVIEW_TO && !!env.ORDER_FROM && !!(env.EMAIL && typeof env.EMAIL.send === "function");

export function requireOrders(env) {
  if (!ordersOn(env)) throw notFound();
}

// GET /employer/config: what the buy page needs before it shows anything.
export function orderConfig(env) {
  return {
    enabled: ordersOn(env),
    prices: PRICES,
    days: DAYS,
    field_cap: FIELD_CAP,
    max_start_days: MAX_START_DAYS,
    terms_version: TERMS_VERSION,
  };
}

function siteOnly(request) {
  if (!SITE.test(request.headers.get("Origin") || "")) {
    throw new HttpError(403, "forbidden", "This is sent from internscout.org only");
  }
}

// ---------------------------------------------------------------- small helpers

const randomHex = (bytes) => hex(crypto.getRandomValues(new Uint8Array(bytes)));

// The email link: 32 random bytes, base64url. Only its SHA-256 (hex) is stored.
export function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function tokenHash(token) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

// Constant time over the two hashes (billing.js sameHex), so a guess learns nothing from the timing.
async function tokenOk(token, hash) {
  if (typeof token !== "string" || !TOKEN.test(token) || typeof hash !== "string" || !hash) return false;
  return sameHex(await tokenHash(token), hash);
}

async function sigOk(env, id, sig) {
  if (typeof id !== "string" || !ORDER_ID.test(id) || typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return false;
  return sameHex(await reviewSig(env, id), sig);
}

async function addressKey(request, env) {
  if (!env.HASH_SALT) throw new HttpError(500, "server", "Server is missing HASH_SALT");
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return "order:" + (await tokenHash(`order|${ip}|${env.HASH_SALT}`));
}

// ---------------------------------------------------------------- loading

async function loadOrder(db, id) {
  if (typeof id !== "string" || !ORDER_ID.test(id)) return null;
  return db.prepare("SELECT * FROM employer_orders WHERE id = ?").bind(id).first();
}

const orderRoles = async (db, id) =>
  (await db.prepare("SELECT * FROM employer_order_roles WHERE order_id = ? ORDER BY rowid").bind(id).all()).results;

// ---------------------------------------------------------------- 1. the order

// POST /employer/order. Answers { ok: true } and nothing else, the same for a honeypot hit, so a bot
// learns nothing. The link goes to the work address only.
export async function takeOrder(db, env, request, body, now, fetchImpl) {
  siteOnly(request);
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw bad(null, "Body must be a JSON object");
  if (isBot(body)) return { ok: true };
  const today = dayOf(now);

  const name = text(body, "name", { required: true });
  const email = text(body, "email", { required: true });
  const company = text(body, "company", { required: true });
  if (!EMAIL.test(email)) throw bad("email", "That email address doesn't look right");
  const domain = email.split("@")[1].toLowerCase();
  if (WEBMAIL.has(domain)) {
    throw bad("email", "Please use your work address at your company's own domain, not a free email service");
  }
  const pkg = typeof body.package === "string" && Object.hasOwn(PRICES, body.package) ? body.package : null;
  if (!pkg) throw bad("package", "package must be \"one\" or \"three\"");
  if (body.public_body != null && typeof body.public_body !== "boolean") throw bad("public_body", "public_body must be true or false");
  const publicBody = body.public_body === true;
  if (body.terms !== true) throw bad("terms", "Please tick the box to accept the employer terms");
  if (body.terms_version !== TERMS_VERSION) throw bad("terms_version", "The employer terms have changed. Reload this page and review them before ordering.");
  const ids = body.roles;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !LISTING_ID.test(id))) {
    throw bad("roles", "roles must be a list of role ids");
  }
  if (new Set(ids).size !== ids.length || ids.length !== PRICES[pkg].roles) {
    throw bad("roles", `This package is for ${rolesWord(PRICES[pkg].roles)}, each picked once`);
  }
  const start = startDay(body.start, today);
  let pilot = "";
  if (body.pilot_code != null && body.pilot_code !== "") {
    pilot = text(body, "pilot_code").toUpperCase();
    if (!PILOT.test(pilot)) throw bad("pilot_code", "That pilot code isn't right");
  }

  // Counted only once the order is well formed, as the interest form does.
  const day = "d:" + today;
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const retry = { retry_after: Math.ceil((midnight - now.getTime()) / 1000) };
  if (!(await bumpUnder(db, await addressKey(request, env), day, PER_ADDRESS_PER_DAY))) {
    throw new HttpError(429, "rate", "That's a lot of orders from one place today. Please try again tomorrow, or email us.", retry);
  }
  if (!(await bumpUnder(db, ALL, day, ALL_PER_DAY))) {
    throw new HttpError(429, "rate", "We are taking no more orders today. Please try again tomorrow, or email us.", retry);
  }

  if (pilot) {
    const free = await db.prepare("SELECT code FROM pilot_codes WHERE code = ? AND order_id IS NULL").bind(pilot).first();
    if (!free) throw bad("pilot_code", "That pilot code isn't right, or it has been used");
  }

  // The roles as InternScout lists them right now, from the shard the page searched.
  const index = await readShard(env, body.shard, fetchImpl);
  const roles = ids.map((id) => index.get(id));
  const missing = ids.find((id, i) => !roles[i]);
  if (missing) throw bad("roles", "One of those roles is not listed as open on InternScout today");
  if (new Set(roles.map((r) => r.k)).size !== 1) throw bad("roles", "All the roles in one order must be from the same employer");
  const unpaid = roles.find((r) => r.unpaid);
  if (unpaid && !publicBody) {
    throw bad("roles", `"${unpaid.t}" doesn't say it is paid. An unpaid role can be listed only by a nonprofit or public body.`);
  }

  const cap = roles.map((r) => ({ id: r.id, fields: fieldsOf(r.f) }));
  const held = await heldRoles(db, now);
  const fit = fitAll(held, cap, start);
  if (!fit.fits) {
    const next = firstFit(held, cap, start);
    throw conflict("full", next
      ? `Those days are full for a field of this order. The first start day with room is ${next}.`
      : "Those days are full for a field of this order.", { roles: fit.roles.filter((r) => !r.fits), next_start: next });
  }

  const id = "o-" + randomHex(8);
  const token = newToken();
  const at = now.toISOString();
  const row = {
    id, created: at, updated: at, status: "unverified", package: pkg, public_body: publicBody ? 1 : 0,
    start_day: start, employer_key: roles[0].k, employer: roles[0].co, company, name, email, email_domain: domain,
    terms_version: TERMS_VERSION, terms_box: TERMS_BOX, terms_at: at, token_hash: await tokenHash(token),
    token_expires: new Date(now.getTime() + TOKEN_HOURS * 3600e3).toISOString(), pilot_code: pilot || null,
    price: pilot ? 0 : PRICES[pkg][publicBody ? "public_body_cents" : "cents"],
  };
  const cols = Object.keys(row);
  await db.batch([
    db.prepare(`INSERT INTO employer_orders (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...cols.map((c) => row[c])),
    ...roles.map((r) => db.prepare(
      "INSERT INTO employer_order_roles (order_id, listing_id, employer_key, company, title, location, apply_url, fields, unpaid) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, r.id, r.k, r.co, r.t, r.loc, r.u, fieldsOf(r.f).join(","), r.unpaid ? 1 : 0)),
  ]);

  // Nothing has been paid yet, so an email that can't be sent undoes the order: the page says so and
  // the employer can try again, rather than waiting for a link that never comes.
  try {
    await sendMail(env, verifyMail(env, row, roles, token));
  } catch (e) {
    console.error("mail failed: order link", e && (e.code || e.name));
    await db.batch([
      db.prepare("DELETE FROM employer_order_roles WHERE order_id = ?").bind(id),
      db.prepare("DELETE FROM employer_orders WHERE id = ?").bind(id),
    ]);
    throw new HttpError(502, "mail", "We couldn't send the confirmation email just now. Please try again in a few minutes.");
  }
  return { ok: true };
}

// ---------------------------------------------------------------- 2. confirm the email

// POST /employer/order/confirm { order, token } -> { url } (Stripe Checkout), { done: "pilot" }, or
// { done: "paid" } when the order is already paid. The link works for TOKEN_HOURS from the order, and
// only for its own order.
export async function confirmOrder(db, env, request, body, now, fetchImpl) {
  siteOnly(request);
  const order = await loadOrder(db, body.order);
  if (!order || !(await tokenOk(body.token, order.token_hash)) || order.token_expires <= now.toISOString()) {
    throw new HttpError(403, "link", "This link has expired or isn't right. Please start a new order on the buy page.");
  }
  if (["paid", "approved", "refused"].includes(order.status)) return { done: "paid" };
  const at = now.toISOString();
  if (order.status === "unverified") {
    await db.prepare("UPDATE employer_orders SET status = 'verified', verified_at = ?, updated = ? WHERE id = ? AND status = 'unverified'")
      .bind(at, at, order.id).run();
  }

  // The cap again: others may have paid since the order was made. A start day that has passed since is
  // checked from today, which is where approval will move it to.
  const roles = await orderRoles(db, order.id);
  const cap = roles.map((r) => ({ id: r.listing_id, fields: fieldsOf(r.fields.split(",").filter(Boolean)) }));
  const from = order.start_day < dayOf(now) ? dayOf(now) : order.start_day;
  const held = await heldRoles(db, now, order.id);
  const fit = fitAll(held, cap, from);
  if (!fit.fits) {
    const next = firstFit(held, cap, from);
    throw conflict("full", "Those days filled up since you ordered. Please start a new order" +
      (next ? ` with a start day from ${next}.` : "."), { roles: fit.roles.filter((r) => !r.fits), next_start: next });
  }

  if (order.pilot_code) {
    const r = await db.prepare("UPDATE pilot_codes SET order_id = ?, used_at = ? WHERE code = ? AND (order_id IS NULL OR order_id = ?)")
      .bind(order.id, at, order.pilot_code, order.id).run();
    if (!r.meta.changes) {
      throw conflict("pilot_used", "That pilot code has been used since you ordered. Please start a new order without it.");
    }
    try {
      await reserveCapacity(db, order, cap, from, now, new Date(now.getTime() + CHECKOUT_HOLD_MS).toISOString());
    } catch (e) {
      await db.prepare("UPDATE pilot_codes SET order_id = NULL, used_at = NULL WHERE code = ? AND order_id = ? " +
        "AND NOT EXISTS (SELECT 1 FROM employer_orders WHERE id = ? AND status IN ('paid', 'approved'))")
        .bind(order.pilot_code, order.id, order.id).run();
      throw e;
    }
    await markPaid(db, env, { ...order, status: "verified" },
      { ref: "pilot:" + order.pilot_code, amount: 0, pi: null, session: null }, now);
    return { done: "pilot" };
  }

  if (order.checkout_url && order.checkout_at && now.getTime() - Date.parse(order.checkout_at) < CHECKOUT_REUSE_MS) {
    return { url: order.checkout_url };
  }
  // The reservation is atomic and happens before an external Checkout exists, not after its response.
  await reserveCapacity(db, order, cap, from, now, new Date(now.getTime() + CHECKOUT_HOLD_MS).toISOString());
  const session = await stripe(env, "checkout/sessions", checkoutForm(env, order, roles, now), fetchImpl,
    `listing-checkout:${order.id}:${Math.floor(now.getTime() / CHECKOUT_REUSE_MS)}`);
  await db.prepare("UPDATE employer_orders SET checkout_session = ?, checkout_url = ?, checkout_at = ?, updated = ? WHERE id = ?")
    .bind(String(session.id || ""), String(session.url || ""), at, at, order.id).run();
  return { url: session.url };
}

// A one-off payment for the order's price. No Managed Payments here: InternScout sells this listing
// itself, so STRIPE_MANAGED_PAYMENTS (which is for the student plans) is never read. Stripe makes an
// invoice for the employer's records.
export function checkoutForm(env, order, roles, now) {
  const site = siteUrl(env);
  const what = `InternScout paid listing: ${rolesWord(roles.length)}, ${DAYS} days each`;
  return {
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(order.price),
    "line_items[0][price_data][product_data][name]": what,
    "line_items[0][price_data][product_data][description]": `Order ${order.id}, ${order.employer}, from ${order.start_day}`,
    customer_email: order.email,
    client_reference_id: order.id,
    "metadata[kind]": "listing",
    "metadata[order]": order.id,
    "payment_intent_data[metadata][kind]": "listing",
    "payment_intent_data[metadata][order]": order.id,
    "invoice_creation[enabled]": "true",
    "invoice_creation[invoice_data][metadata][order]": order.id,
    allow_promotion_codes: "true",
    expires_at: String(Math.floor(now.getTime() / 1000) + CHECKOUT_EXPIRES_S),
    success_url: `${site}/employers/buy/?paid=${order.id}`,
    cancel_url: `${site}/employers/buy/?cancelled=1`,
  };
}

// ---------------------------------------------------------------- 3. paid

// verified -> paid, once. Then the draft placements and both emails. An email that fails is logged and
// left for the daily cron (review_sent_at stays empty); it never undoes the payment record.
async function markPaid(db, env, order, pay, now) {
  const at = now.toISOString();
  const r = await db.prepare(
    "UPDATE employer_orders SET status = 'paid', paid_ref = ?, paid_amount = ?, payment_intent = ?, paid_session = ?, " +
    "paid_at = ?, updated = ? WHERE id = ? AND status = 'verified'",
  ).bind(pay.ref, pay.amount, pay.pi, pay.session, at, at, order.id).run();
  if (!r.meta.changes) return false;
  const fresh = await loadOrder(db, order.id);
  // A delayed bank payment can arrive after its temporary hold. Keep the payment/review record even
  // if capacity has since filled; approval reserves its dates again and cannot overbook the field.
  try {
    const cap = (await orderRoles(db, order.id)).map(r => ({ id: r.listing_id, fields: fieldsOf(r.fields.split(",")) }));
    await reserveCapacity(db, fresh, cap, fresh.start_day, now);
  } catch (e) {
    if (!(e instanceof HttpError) || e.code !== "full") throw e;
  }
  await settle(db, env, fresh, now);
  return true;
}

// What a paid order needs and may not have yet: its draft placements and Bruce's review email. Safe to
// run again (a Stripe retry, the daily cron).
async function settle(db, env, order, now) {
  if (order.status !== "paid") return;
  await ensurePlacements(db, order, now);
  await queueOrderMail(db, env, { orderId: order.id, kind: "receipt", mail: receivedMail(env, order, await orderRoles(db, order.id)) }, now);
  if (!order.review_sent_at) await sendReview(db, env, order, now);
}

// One draft placement per role (placements.js createPlacement, created_by "checkout"), made once.
async function ensurePlacements(db, order, now) {
  for (const role of await orderRoles(db, order.id)) {
    if (role.placement_id) continue;
    await createPlacement(db, {
      employer: role.company, listing_id: role.listing_id, apply_url: role.apply_url,
      start: order.start_day, end: addDays(order.start_day, DAYS), note: `order ${order.id}`, by: "checkout",
    }, now, order.id); // 2026-10-23: creation and attachment are atomic; was: a second, racy UPDATE (W3).
  }
}

async function sendReview(db, env, order, now, reminder = false) {
  const roles = await orderRoles(db, order.id);
  const sent = await trySend(env, await reviewMail(env, order, roles, reminder), reminder ? "review reminder" : "review");
  if (sent) {
    const col = reminder ? "reminder_sent_at" : "review_sent_at";
    await db.prepare(`UPDATE employer_orders SET ${col} = ? WHERE id = ?`).bind(now.toISOString(), order.id).run();
  }
  return sent;
}

const piOf = (o) => (typeof o.payment_intent === "string" ? o.payment_intent : (o.payment_intent && o.payment_intent.id) || null);

// Called from billing.js applyFresh for every verified Stripe event, before the student plans. Returns
// null when the event is not about a listing, so the student-plan handling runs exactly as before.
export async function listingEvent(db, env, event, now, fetchImpl) {
  const o = (event.data && event.data.object) || {};
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    if (!o.metadata || o.metadata.kind !== "listing") return null;
    return sessionPaid(db, env, o, now, fetchImpl);
  }
  if (event.type === "charge.dispute.created" || event.type === "charge.refunded") {
    const pi = piOf(o);
    const order = pi ? await db.prepare("SELECT * FROM employer_orders WHERE payment_intent = ?").bind(pi).first() : null;
    if (!order) return null;
    // A refund of a listing payment is one this file made (or Bruce made by hand); the order says so.
    if (event.type === "charge.refunded") return { ok: true, ignored: true };
    return disputed(db, env, order, now);
  }
  return null;
}

async function sessionPaid(db, env, o, now, fetchImpl) {
  // "unpaid" is a bank payment still on its way: checkout.session.async_payment_succeeded follows.
  if (o.payment_status !== "paid" && o.payment_status !== "no_payment_required") return { ok: true, waiting: true };
  const pi = piOf(o);
  const id = (o.metadata && o.metadata.order) || o.client_reference_id;
  let order = await loadOrder(db, id);
  if (!order) {
    console.error("listing payment without an order");
    await trySend(env, { to: env.REVIEW_TO, subject: "Listing payment without an order",
      text: `Stripe reported a paid listing Checkout session (${o.id || "no id"}) for order ${String(id || "none").slice(0, 40)}, ` +
        "which is not in the database. Nothing was changed. Look it up in the Stripe dashboard and refund it there if needed.\n" }, "orphan");
    return { ok: true, ignored: true };
  }
  if (order.status === "verified") {
    const ref = "stripe:" + (pi || "nocharge:" + order.id);
    const amount = Number.isSafeInteger(o.amount_total) ? o.amount_total : order.price;
    if (await markPaid(db, env, order, { ref, amount, pi, session: o.id || null }, now)) return { ok: true };
    order = await loadOrder(db, order.id);
  }
  // The same payment again (a retry, or completed and then async_payment_succeeded): finish what may
  // not have been done.
  if ((o.id && order.paid_session === o.id) || (pi && order.payment_intent === pi)) {
    await settle(db, env, order, now);
    return { ok: true, repeat: true };
  }
  // A second payment for an order that is already paid (two Checkout tabs, both paid): refunded in full.
  if (pi) {
    const refund = await stripe(env, "refunds", { payment_intent: pi, "metadata[order]": order.id, "metadata[why]": "duplicate" },
      fetchImpl, `listing-refund-duplicate:${pi}`);
    const amount = Number.isSafeInteger(refund && refund.amount) ? refund.amount : o.amount_total;
    await trySend(env, { to: env.REVIEW_TO, subject: `Order ${order.id} was paid twice; the second payment was refunded`,
      text: `Order ${order.id} (${order.employer}) was paid a second time (${pi}). That payment, ${money(amount)}, was refunded ` +
        "automatically. Nothing else changed.\n" }, "duplicate");
    await trySend(env, { to: order.email, replyTo: env.REVIEW_TO, subject: "We refunded a second payment for your InternScout order",
      text: `Hello ${order.name},\n\nOrder ${order.id} was paid twice, probably from two open payment pages. We refunded the ` +
        `second payment, ${money(amount)}, to the card it came from. Stripe says a refund usually shows within 5 to 10 ` +
        "business days. Your order itself is unchanged.\n\nInternScout\n" }, "duplicate");
    return { ok: true, refunded: "duplicate" };
  }
  return { ok: true, ignored: true };
}

// A dispute pauses the order's live placements and tells Bruce. Everything else about it stays manual.
async function disputed(db, env, order, now) {
  await db.prepare("UPDATE employer_orders SET disputed_at = ?, updated = ? WHERE id = ?")
    .bind(now.toISOString(), now.toISOString(), order.id).run();
  const paused = [];
  for (const role of await orderRoles(db, order.id)) {
    if (!role.placement_id) continue;
    const p = await db.prepare("SELECT id, status FROM placements WHERE id = ?").bind(role.placement_id).first();
    if (!p || p.status !== "on") continue;
    try {
      await pausePlacement(db, { id: p.id, by: "stripe", reason: "payment dispute" }, now);
      paused.push(`${role.title} (${p.id})`);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
    }
  }
  await trySend(env, { to: env.REVIEW_TO, subject: `Payment dispute on listing order ${order.id}`,
    text: `A payment dispute was opened on order ${order.id} (${order.employer}, ${money(order.paid_amount)}).\n\n` +
      (paused.length ? `These listings were paused:\n${paused.map((p) => "- " + p).join("\n")}\n\n` : "No listing was live, so nothing was paused.\n\n") +
      "Answer the dispute in the Stripe dashboard. Switching a listing back on, or ending it, is done with scripts/placement.mjs.\n" }, "dispute");
  return { ok: true, paused: paused.length };
}

// ---------------------------------------------------------------- 4. review

const STYLE = "body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}" +
  "h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:1.6rem}table{border-collapse:collapse}td,th{text-align:left;" +
  "vertical-align:top;padding:.2rem .8rem .2rem 0}.warn{color:#a40000;font-weight:600}.ok{color:#0a5a1f}" +
  "form{margin:1rem 0;padding:1rem;border:1px solid #ccc}textarea{width:100%;font:inherit}button{font:inherit;padding:.4rem 1rem}" +
  "li{margin:.4rem 0}code{word-break:break-all}";
let styleHash;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// A self-contained page: no script at all, the one style block allowed by its hash, forms that post
// back to this Worker only, and nothing kept by the browser or sent on as a referrer (the link is signed).
async function page(title, body, status = 200) {
  styleHash ||= btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(STYLE)))));
  const html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta name=\"robots\" content=\"noindex\">" +
    `<title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${styleHash}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

const message = (title, text, status) => page(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`, status);

// GET /employer/review?order=&sig=: everything Bruce needs for the sponsor checks, on one page.
export async function reviewPage(db, env, params, now, fetchImpl) {
  const id = params.get("order");
  if (!(await sigOk(env, id, params.get("sig")))) return message("Link not valid", "This review link is not valid.", 403);
  const order = await loadOrder(db, id);
  if (!order) return message("No such order", "This order is not in the database.", 404);
  const roles = await orderRoles(db, id);
  const sig = await reviewSig(env, id);
  const today = dayOf(now);

  let index = null;
  try {
    index = await readShard(env, shardOf(order.employer_key), fetchImpl);
  } catch {}
  const placements = {};
  for (const r of roles) {
    if (r.placement_id) placements[r.placement_id] = await db.prepare("SELECT * FROM placements WHERE id = ?").bind(r.placement_id).first();
  }
  const start = order.start_day < today ? today : order.start_day;
  const end = addDays(start, DAYS);
  const held = await heldRoles(db, now, id);
  const fields = [...new Set(roles.flatMap((r) => r.fields.split(",").filter(Boolean)))];

  const row = (k, v) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;
  const host = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
  const rolesHtml = roles.map((r) => {
    const now_ = index ? index.get(r.listing_id) : null;
    const state = !index ? "<span class=\"warn\">The role index could not be read just now.</span>"
      : !now_ ? "<span class=\"warn\">No longer listed as open on InternScout.</span>"
      : "<span class=\"ok\">Listed as open on InternScout today.</span>" +
        (now_.u !== r.apply_url ? ` <span class="warn">Its apply link changed to <code>${esc(now_.u)}</code>.</span>` : "") +
        (now_.unpaid ? " <span class=\"warn\">The posting doesn't say it is paid.</span>" : "");
    const p = r.placement_id && placements[r.placement_id];
    return `<li><strong>${esc(r.title)}</strong>, ${esc(r.company)}${r.location ? ", " + esc(r.location) : ""}<br>` +
      `Apply link: <a href="${esc(r.apply_url)}" rel="noreferrer noopener" target="_blank"><code>${esc(r.apply_url)}</code></a> ` +
      `(host ${esc(host(r.apply_url))})<br>Fields: ${esc(r.fields || "other")}. ${r.unpaid ? "<span class=\"warn\">Unpaid when ordered.</span> " : ""}` +
      `${state}<br>Placement: ${p ? `${esc(p.id)}, ${esc(p.status)}, ${esc(p.start_day)} to ${esc(p.end_day)}` : "not made yet"}</li>`;
  }).join("");
  const fieldsHtml = fields.map((f) =>
    `<li>${esc(f)}: ${busiest(held, f, start, end)} other paid roles on the busiest day (cap ${FIELD_CAP}, this order adds ` +
    `${roles.filter((r) => r.fields.split(",").includes(f)).length})</li>`).join("");

  const decided = order.status !== "paid";
  const forms = decided
    ? `<p class="warn">This order is ${esc(order.status)}; there is nothing to decide.</p>`
    : (order.disputed_at ? "<p class=\"warn\">A payment dispute is open on this order, so it can't be approved. Refuse it, or answer the dispute in Stripe first.</p>" :
      `<form method="post" action="/employer/review"><input type="hidden" name="order" value="${esc(id)}">` +
      `<input type="hidden" name="sig" value="${esc(sig)}"><input type="hidden" name="action" value="approve">` +
      `<p>Approve records all ${CHECKS.length} sponsor checks as done by you, switches every role on from ` +
      `${esc(start)} to ${esc(addDays(end, -1))} (last day) and emails the employer the dates.</p><button>Approve</button></form>`) +
      `<form method="post" action="/employer/review"><input type="hidden" name="order" value="${esc(id)}">` +
      `<input type="hidden" name="sig" value="${esc(sig)}"><input type="hidden" name="action" value="refuse">` +
      `<p><label for="reason">Refuse: the reason the employer will read (required)</label></p>` +
      `<textarea id="reason" name="reason" rows="3" maxlength="${LIMITS.reason}" required></textarea>` +
      `<p>Refuse refunds ${order.payment_intent ? "the full amount through Stripe" : "nothing (no card payment)"}, marks the placements ` +
      `refused${order.pilot_code ? ", frees the pilot code" : ""} and emails the employer the reason.</p><button>Refuse</button></form>`;

  const body = `<h1>Listing order ${esc(id)}</h1>` +
    `<table>${[
      row("Status", esc(order.status) + (order.disputed_at ? " <span class=\"warn\">(payment disputed)</span>" : "")),
      row("Employer (role index)", esc(order.employer)),
      row("Company typed", esc(order.company)),
      row("Contact", esc(order.name)),
      row("Verified work email", `${esc(order.email)} (domain <strong>${esc(order.email_domain)}</strong>; compare with the apply link hosts below)`),
      row("Nonprofit or public body", order.public_body ? "<span class=\"warn\">Yes, claimed. Check it.</span>" : "No"),
      row("Package", `${esc(order.package)}, ${rolesWord(roles.length)}, ${DAYS} days each`),
      row("Paid", `${money(order.paid_amount)} (${esc(order.paid_ref || "")})${order.pilot_code ? " pilot" : ""}`),
      row("Start asked", esc(order.start_day) + (order.start_day < today ? ` <span class="warn">has passed; approving today runs ${esc(start)} to ${esc(addDays(end, -1))}</span>` : "")),
      row("Terms accepted", `${esc(order.terms_version)} at ${esc(order.terms_at)}: "${esc(order.terms_box || "")}"`),
      row("Ordered", esc(order.created)),
    ].join("")}</table>` +
    `<h2>The roles, as InternScout lists them now</h2><ul>${rolesHtml}</ul>` +
    `<h2>Field counts for ${esc(start)} to ${esc(addDays(end, -1))}</h2><ul>${fieldsHtml}</ul>` +
    `<h2>The sponsor checks Approve records</h2><ul>${CHECKS.map((c) => `<li><code>${esc(c)}</code></li>`).join("")}</ul>` +
    `<h2>Decision</h2>${forms}`;
  return page(`Order ${id}`, body);
}

async function readForm(request) {
  if (Number(request.headers.get("Content-Length")) > MAX_FORM_BYTES) throw new HttpError(400, "bad_request", "Request body is too large");
  const type = request.headers.get("Content-Type") || "";
  if (!/^application\/x-www-form-urlencoded\b/i.test(type)) throw new HttpError(400, "bad_request", "Send the review form");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_FORM_BYTES) throw new HttpError(400, "bad_request", "Request body is too large");
  return new URLSearchParams(raw);
}

// POST /employer/review (form): approve or refuse. Answers a plain page.
export async function reviewDecision(db, env, request, now, fetchImpl) {
  const form = await readForm(request);
  const id = form.get("order");
  if (!(await sigOk(env, id, form.get("sig")))) return message("Link not valid", "This review link is not valid.", 403);
  const order = await loadOrder(db, id);
  if (!order) return message("No such order", "This order is not in the database.", 404);
  if (order.status !== "paid") return message("Already decided", `This order is ${order.status}; nothing was changed.`, 409);
  const action = form.get("action");
  if (!["approve", "refuse"].includes(action)) return message("Not done", "Choose Approve or Refuse.", 400);
  let reason;
  if (action === "refuse") {
    try { reason = text({ reason: form.get("reason") }, "reason", { required: true }); }
    catch (e) { if (e instanceof HttpError) return message("Not done", e.message, e.status); throw e; }
  }
  if (action === "approve" && order.disputed_at) return message("Not approved", "A payment dispute is open on this order, so it was not approved.", 409);
  const claim = await db.prepare("INSERT OR IGNORE INTO employer_decisions (order_id, action, state, created, updated) VALUES (?, ?, 'running', ?, ?)")
    .bind(id, action, now.toISOString(), now.toISOString()).run();
  if (!claim.meta.changes) return message("Decision held", "A decision already started for this order. Check its records and Stripe before retrying or choosing the opposite action.", 409);
  try {
    if (action === "approve") {
      if (order.disputed_at) return message("Not approved", "A payment dispute is open on this order, so it was not approved.", 409);
      const dates = await approve(db, env, order, now);
      await db.prepare("UPDATE employer_decisions SET state = 'done', updated = ? WHERE order_id = ?").bind(now.toISOString(), id).run();
      return message("Approved", `Order ${id} is approved. Its roles run ${dates}. Confirmation email is recorded for delivery.`);
    }
    if (action === "refuse") {
      const refunded = await refuse(db, env, order, reason, now, fetchImpl);
      await db.prepare("UPDATE employer_decisions SET state = 'done', updated = ? WHERE order_id = ?").bind(now.toISOString(), id).run();
      return message("Refused", `Order ${id} is refused. ${refunded ? `${money(refunded)} was refunded. ` : ""}The reason email is recorded for delivery.`);
    }
  } catch (e) {
    // Capacity refusal happens before approval changes anything; it is safe to choose refusal later.
    if (action === "approve" && e instanceof HttpError && e.code === "full") {
      await db.prepare("DELETE FROM employer_decisions WHERE order_id = ?").bind(id).run();
    } else {
      await db.prepare("UPDATE employer_decisions SET state = 'unknown', updated = ? WHERE order_id = ?").bind(now.toISOString(), id).run();
    }
    if (e instanceof HttpError) return message("Not done", e.message, e.status);
    throw e;
  }
  return message("Not done", "Choose Approve or Refuse.", 400);
}

// The same steps Bruce runs by hand, by "bruce", each one skipped if it is already done, so a second
// click after a failure finishes the job. Returns the dates as text for the page.
async function approve(db, env, order, now) {
  const today = dayOf(now);
  const roles = await orderRoles(db, order.id);
  const start = order.start_day < today ? today : order.start_day;
  await reserveCapacity(db, order, roles.map(r => ({ id: r.listing_id, fields: fieldsOf(r.fields.split(",")) })), start, now);
  await ensurePlacements(db, order, now);
  const placed = await orderRoles(db, order.id);
  const done = [];
  for (const role of placed) {
    let p = await db.prepare("SELECT * FROM placements WHERE id = ?").bind(role.placement_id).first();
    if (["draft", "checked"].includes(p.status) && p.start_day < today) {
      // No paid day is lost to the review: the 30 days start on the day of approval.
      p = await updatePlacement(db, { id: p.id, by: "bruce", start: today, end: addDays(today, DAYS) }, now);
    }
    if (p.status === "draft") {
      p = await checkPlacement(db, { id: p.id, by: "bruce", checks: CHECKS, unpaid_ok: !!(role.unpaid && order.public_body) }, now);
    }
    if (p.status === "checked") p = await switchOn(db, { id: p.id, by: "bruce", paid_ref: order.paid_ref }, now);
    if ((await loadOrder(db, order.id)).disputed_at) {
      if (p.status === "on") await pausePlacement(db, { id: p.id, by: "stripe", reason: "payment dispute during approval" }, now);
      throw conflict("disputed", "A payment dispute arrived during approval. The listing is paused; reconcile the order before continuing.");
    }
    if (p.status !== "on") throw conflict("conflict", `Placement ${p.id} is ${p.status}, so it was not switched on.`);
    done.push({ role, p });
  }
  const at = now.toISOString();
  const approvalNotice = { orderId: order.id, kind: "approved", mail: approvedMail(env, order, done) };
  await queueOrderMail(db, env, { ...approvalNotice, defer: true }, now);
  const approved = await db.prepare("UPDATE employer_orders SET status = 'approved', decided_at = ?, updated = ? WHERE id = ? AND status = 'paid' AND disputed_at IS NULL")
    .bind(at, at, order.id).run();
  if (!approved.meta.changes) throw conflict("disputed", "The order changed during approval. Reconcile it before continuing.");
  await queueOrderMail(db, env, approvalNotice, now);
  const spans = [...new Set(done.map(({ p }) => `${p.start_day} to ${addDays(p.end_day, -1)}`))];
  return spans.join(", ");
}

// Refund first (one idempotency key per order, so a second click never refunds twice), then the records.
async function refuse(db, env, order, reason, now, fetchImpl) {
  let refund = null;
  if (order.payment_intent && order.paid_amount > 0) {
    refund = await stripe(env, "refunds", { payment_intent: order.payment_intent, "metadata[order]": order.id, "metadata[why]": "refused" },
      fetchImpl, `listing-refund:${order.id}`);
    if (!refund || typeof refund.id !== "string" || !refund.id) throw new Error("Refund result unknown");
  }
  for (const role of await orderRoles(db, order.id)) {
    if (!role.placement_id) continue;
    const p = await db.prepare("SELECT status FROM placements WHERE id = ?").bind(role.placement_id).first();
    if (p && ["draft", "checked"].includes(p.status)) await refusePlacement(db, { id: role.placement_id, by: "bruce", reason }, now);
  }
  const at = now.toISOString();
  const amount = refund ? (Number.isSafeInteger(refund.amount) ? refund.amount : order.paid_amount) : 0;
  const refusalNotice = { orderId: order.id, kind: "refused", mail: refusedMail(env, order, reason, amount) };
  await queueOrderMail(db, env, { ...refusalNotice, defer: true }, now);
  await db.batch([
    db.prepare("UPDATE employer_orders SET status = 'refused', decided_at = ?, decided_reason = ?, refund_id = ?, " +
      "refunded_amount = ?, updated = ? WHERE id = ? AND status = 'paid'")
      .bind(at, reason, refund ? String(refund.id || "") : null, amount, at, order.id),
    // A refused pilot does not use up one of the five.
    db.prepare("UPDATE pilot_codes SET order_id = NULL, used_at = NULL WHERE order_id = ?").bind(order.id),
  ]);
  await queueOrderMail(db, env, refusalNotice, now);
  return amount;
}

// ---------------------------------------------------------------- 5. a role closes early

// GET /employer/credit?credit=&t=: the offer, for the buy page to show.
export async function creditInfo(db, params, now) {
  const credit = await loadCredit(db, params.get("credit"), params.get("t"));
  const job = await db.prepare("SELECT state FROM employer_credit_jobs WHERE credit_id = ?").bind(credit.id).first();
  const role = await db.prepare("SELECT title, company FROM employer_order_roles WHERE placement_id = ?").bind(credit.placement_id).first();
  return {
    credit: credit.id, status: credit.status, amount: credit.amount, unused_days: credit.unused_days,
    role: role ? { title: role.title, company: role.company } : null,
    choose_by: addDays((credit.offer_sent_at || now.toISOString()).slice(0, 10), CREDIT_DEFAULT_DAYS),
    ...(job && job.state !== "done" ? { processing: job.state } : {}),
    ...(credit.status === "credit" ? { code: credit.promotion_code } : {}),
  };
}

async function loadCredit(db, id, token) {
  const credit = typeof id === "string" && CREDIT_ID.test(id)
    ? await db.prepare("SELECT * FROM employer_credits WHERE id = ?").bind(id).first() : null;
  if (!credit || !(await tokenOk(token, credit.token_hash))) {
    throw new HttpError(403, "link", "This link isn't right. Please use the link in our email, or reply to it.");
  }
  return credit;
}

// POST /employer/credit { credit, token, choice: "refund" | "credit" }.
export async function chooseCredit(db, env, request, body, now, fetchImpl) {
  siteOnly(request);
  const credit = await loadCredit(db, body.credit, body.token);
  if (body.choice !== "refund" && body.choice !== "credit") throw bad("choice", "choice must be \"refund\" or \"credit\"");
  if (credit.status !== "offered") {
    throw conflict("decided", credit.status === "credit" ? "You already chose a promotion code." : "This has already been refunded.",
      { status: credit.status, ...(credit.status === "credit" ? { code: credit.promotion_code } : {}) });
  }
  const done = await settleCredit(db, env, credit, body.choice, "employer", now, fetchImpl);
  if (!done) throw conflict("processing", "Your choice is being reconciled. Do not choose again; reply to your order email for help.");
  return body.choice === "refund" ? { done: "refund", amount: credit.amount } : { done: "credit", code: done.code, amount: credit.amount };
}

// A permanent choice claim precedes Stripe. An ambiguous result or a crash cannot change choice or
// blindly repeat a payout after the provider's idempotency window; the owner reconciles it instead.
async function settleCredit(db, env, credit, choice, who, now, fetchImpl) {
  const at = now.toISOString();
  const claim = await db.prepare("INSERT OR IGNORE INTO employer_credit_jobs (credit_id, order_id, choice, state, created, updated) " +
    "SELECT ?, ?, ?, 'running', ?, ? WHERE EXISTS (SELECT 1 FROM employer_credits WHERE id = ? AND status = 'offered')")
    .bind(credit.id, credit.order_id, choice, at, at, credit.id).run();
  if (!claim.meta.changes) return null;
  const order = await db.prepare("SELECT * FROM employer_orders WHERE id = ?").bind(credit.order_id).first();
  try {
    if (!order || order.disputed_at || order.status === "refused") {
      throw conflict("reconcile", "This order needs payment reconciliation before any refund or promotion code. Reply to your order email for help.");
    }
    if (choice === "refund") {
      const refund = await stripe(env, "refunds", { payment_intent: order.payment_intent, amount: String(credit.amount),
        "metadata[order]": order.id, "metadata[credit]": credit.id, "metadata[why]": "role_closed" }, fetchImpl, `listing-credit-refund:${credit.id}`);
      if (!refund || typeof refund.id !== "string" || !refund.id) throw new Error("Refund result unknown");
      await db.batch([
        db.prepare("UPDATE employer_credits SET status = 'refund', refund_id = ?, chosen_at = ?, chosen_by = ?, updated = ? WHERE id = ? AND status = 'offered'")
          .bind(refund.id, at, who, at, credit.id),
        db.prepare("UPDATE employer_credit_jobs SET state = 'done', updated = ? WHERE credit_id = ?").bind(at, credit.id),
      ]);
      await trySend(env, creditMail(env, order, credit, who === "default" ? "default" : "refund"), "credit refund");
      return { refund: refund.id };
    }
    // A one-time code worth the amount. Restricted to orders of at least the smallest listing price, so
    // it can't be spent on a student plan, whose Checkout also takes promotion codes.
    const coupon = await stripe(env, "coupons", { amount_off: String(credit.amount), currency: "usd", duration: "once",
      max_redemptions: "1", name: "InternScout listing credit", "metadata[credit]": credit.id }, fetchImpl, `listing-coupon:${credit.id}`);
    if (!coupon || typeof coupon.id !== "string" || !coupon.id) throw new Error("Coupon result unknown");
    const promo = await stripe(env, "promotion_codes", { "promotion[type]": "coupon", "promotion[coupon]": String(coupon.id),
      max_redemptions: "1", "restrictions[minimum_amount]": String(PRICES.one.public_body_cents),
      "restrictions[minimum_amount_currency]": "usd", "metadata[credit]": credit.id }, fetchImpl, `listing-promo:${credit.id}`);
    if (!promo || typeof promo.code !== "string" || !promo.code) throw new Error("Promotion result unknown");
    const code = promo.code;
    await db.batch([
      db.prepare("UPDATE employer_credits SET status = 'credit', promotion_code = ?, chosen_at = ?, chosen_by = ?, updated = ? WHERE id = ? AND status = 'offered'")
        .bind(code, at, who, at, credit.id),
      db.prepare("UPDATE employer_credit_jobs SET state = 'done', updated = ? WHERE credit_id = ?").bind(at, credit.id),
    ]);
    await trySend(env, creditMail(env, order, { ...credit, promotion_code: code }, "credit"), "credit code");
    return { code };
  } catch (e) {
    await db.prepare("UPDATE employer_credit_jobs SET state = 'unknown', updated = ? WHERE credit_id = ?")
      .bind(at, credit.id).run();
    throw e;
  }
}

// ---------------------------------------------------------------- the daily cron

export async function ordersCron(db, env, now, fetchImpl = (...a) => fetch(...a)) {
  await dropUnverifiedOrders(db, now);
  await dropRetainedOrders(db, now);
  if (!ordersOn(env)) return;
  for (const job of [fillPlacementFields, resendReviews, remindReviews, closeRoles, resendOffers, defaultCredits, retryOrderMail, alertFinancialHolds]) {
    try {
      await job(db, env, now, fetchImpl);
    } catch (e) {
      console.error("orders cron failed:", job.name, e && e.name);
    }
  }
}

// Crash/unknown claims remain visible, never silently reset. One owner alert, retried if mail fails.
async function alertFinancialHolds(db, env, now) {
  const cutoff = new Date(now.getTime() - 15 * 60_000).toISOString();
  for (const [table, idField] of [["employer_decisions", "order_id"], ["employer_credit_jobs", "credit_id"]]) {
    const { results } = await db.prepare(`SELECT * FROM ${table} WHERE state != 'done' AND alerted_at IS NULL AND (state = 'unknown' OR created < ?)`)
      .bind(cutoff).all();
    for (const job of results) {
      if (await trySend(env, { to: env.REVIEW_TO, subject: "InternScout financial operation needs reconciliation",
        text: `Order ${job.order_id}; operation ${job[idField]} (${job.action || job.choice}) is ${job.state}. ` +
          "Check the order, placement records and Stripe before any retry, opposite decision or second payout. " +
          "Automatic retries are held to avoid duplicate compensation. See worker/ORDERS.md." }, "financial reconciliation")) {
        await db.prepare(`UPDATE ${table} SET alerted_at = ? WHERE ${idField} = ?`).bind(now.toISOString(), job[idField]).run();
      }
    }
  }
}

// An order never confirmed is deleted after UNVERIFIED_DAYS (docs/privacy.html#employers).
export async function dropUnverifiedOrders(db, now) {
  const cutoff = new Date(now.getTime() - UNVERIFIED_DAYS * 86400e3).toISOString();
  await db.batch([
    // A crash after claiming a free pilot can be retried by that same order. Once its link expires,
    // release an unpaid abandoned claim; temporary capacity already expired after 35 minutes.
    db.prepare("UPDATE pilot_codes SET order_id = NULL, used_at = NULL WHERE order_id IN " +
      "(SELECT id FROM employer_orders WHERE status = 'verified' AND paid_at IS NULL AND token_expires <= ?)").bind(now.toISOString()),
    db.prepare("DELETE FROM employer_order_roles WHERE order_id IN (SELECT id FROM employer_orders WHERE status = 'unverified' AND created < ?)").bind(cutoff),
    db.prepare("DELETE FROM employer_orders WHERE status = 'unverified' AND created < ?").bind(cutoff),
  ]);
}

// A paid order whose review email did not go (or whose placements were not all made).
async function resendReviews(db, env, now) {
  const { results } = await db.prepare("SELECT * FROM employer_orders WHERE status = 'paid' AND review_sent_at IS NULL").all();
  for (const order of results) await settle(db, env, order, now);
}

// Once, when an order has waited more than a day for a decision.
async function remindReviews(db, env, now) {
  const cutoff = new Date(now.getTime() - REMIND_AFTER_MS).toISOString();
  const { results } = await db.prepare(
    "SELECT * FROM employer_orders WHERE status = 'paid' AND paid_at < ? AND review_sent_at IS NOT NULL AND reminder_sent_at IS NULL",
  ).bind(cutoff).all();
  for (const order of results) await sendReview(db, env, order, now, true);
}

// A day every site build dropped the placement for a closing reason.
const closedDay = (r) => r && r.shown === 0 && r.dropped > 0 && CLOSE_REASONS.includes(r.reason);

// A live order placement that every build dropped on both of the last two whole days ends (role_closed).
// Its unused days, from the first such day, times the role's share of what was paid, over DAYS, are
// offered back as a refund or a promotion code. A pilot (nothing paid) is only told it stopped.
async function closeRoles(db, env, now) {
  const today = dayOf(now);
  const d1 = addDays(today, -1), d2 = addDays(today, -2);
  const { results } = await db.prepare(
    "SELECT r.order_id, r.title, r.placement_id, p.start_day, p.end_day FROM employer_order_roles r " +
    "JOIN placements p ON p.id = r.placement_id WHERE (p.status = 'on' OR (p.status = 'ended' AND p.ended_reason = 'dates')) AND p.start_day <= ?",
  ).bind(d2).all();
  for (const r of results) {
    const runs = (await db.prepare("SELECT day, shown, dropped, reason FROM placement_runs WHERE placement_id = ? AND day <= ? ORDER BY day DESC")
      .bind(r.placement_id, d1).all()).results;
    const byDay = Object.fromEntries(runs.map((x) => [x.day, x]));
    if (!closedDay(byDay[d1]) || !closedDay(byDay[d2])) continue;
    let first = d2;
    while (first > r.start_day && closedDay(byDay[addDays(first, -1)])) first = addDays(first, -1);
    const order = await db.prepare("SELECT * FROM employer_orders WHERE id = ?").bind(r.order_id).first();
    const allRoles = await orderRoles(db, order.id);
    const count = allRoles.length || 1;
    const index = allRoles.findIndex(x => x.placement_id === r.placement_id);
    const paid = Math.max(0, Number(order.paid_amount) || 0);
    // Allocate remainder cents once, so three $35 roles refund 1167 + 1167 + 1166, never 3501.
    const share = Math.floor(paid / count) + (index < paid % count ? 1 : 0);
    const unused = Math.max(0, Math.min(DAYS, daysBetween(first, r.end_day)));
    const amount = Math.round(unused * share / DAYS);
    const token = newToken();
    const credit = amount > 0 && order.payment_intent ? { id: "c-" + randomHex(8), order_id: order.id, placement_id: r.placement_id, created: now.toISOString(),
      amount, unused_days: unused, token_hash: await tokenHash(token), status: "offered", updated: now.toISOString() } : null;
    const before = await db.prepare("SELECT * FROM placements WHERE id = ?").bind(r.placement_id).first();
    if (!before || !(before.status === "on" || (before.status === "ended" && before.ended_reason === "dates"))) continue;
    if (before.status === "ended" && unused === 0) continue;
    const at = new Date(Math.max(now.getTime(), Date.parse(before.updated) + 1)).toISOString();
    const after = { ...before, status: "ended", ended_reason: "role_closed", updated: at, updated_by: "cron" };
    const statements = [
      db.prepare("UPDATE placements SET status = 'ended', ended_reason = 'role_closed', updated = ?, updated_by = 'cron' WHERE id = ? AND status = ? AND updated = ?")
        .bind(at, before.id, before.status, before.updated),
      db.prepare("INSERT INTO placement_log (placement, at, by, action, reason, before, after) SELECT ?, ?, 'cron', 'end', 'role_closed', ?, ? " +
        "WHERE EXISTS (SELECT 1 FROM placements WHERE id = ? AND updated = ? AND updated_by = 'cron')")
        .bind(before.id, at, JSON.stringify(before), JSON.stringify(after), before.id, at),
      db.prepare("DELETE FROM employer_capacity_reservations WHERE order_id = ? AND listing_id = ?").bind(order.id, before.listing_id),
    ];
    if (credit) {
    const cols = Object.keys(credit);
      statements.push(db.prepare(`INSERT OR IGNORE INTO employer_credits (${cols.join(", ")}) SELECT ${cols.map(() => "?").join(", ")} ` +
        "WHERE EXISTS (SELECT 1 FROM placements WHERE id = ? AND updated = ? AND updated_by = 'cron')")
        .bind(...cols.map(c => credit[c]), before.id, at));
    }
    const [ended] = await db.batch(statements);
    if (!ended.meta.changes) continue;
    if (!credit) {
      await trySend(env, closedMail(env, order, r, first, unused, 0, null), "role closed");
      continue;
    }
    if (await trySend(env, closedMail(env, order, r, first, unused, amount, { ...credit, token, offer_sent_at: now.toISOString() }), "credit offer")) {
      await db.prepare("UPDATE employer_credits SET offer_sent_at = ? WHERE id = ?").bind(now.toISOString(), credit.id).run();
    }
  }
}

// An offer whose email did not go. The link needs a token, and only its hash is kept, so a new one is made.
async function resendOffers(db, env, now) {
  const { results } = await db.prepare(
    "SELECT c.*, r.title FROM employer_credits c JOIN employer_order_roles r ON r.placement_id = c.placement_id " +
    "WHERE c.status = 'offered' AND c.offer_sent_at IS NULL",
  ).all();
  for (const c of results) {
    const order = await db.prepare("SELECT * FROM employer_orders WHERE id = ?").bind(c.order_id).first();
    const p = await db.prepare("SELECT start_day, end_day FROM placements WHERE id = ?").bind(c.placement_id).first();
    const token = newToken();
    await db.prepare("UPDATE employer_credits SET token_hash = ? WHERE id = ?").bind(await tokenHash(token), c.id).run();
    const first = addDays(p.end_day, -c.unused_days);
    if (await trySend(env, closedMail(env, order, { title: c.title }, first, c.unused_days, c.amount, { ...c, token, offer_sent_at: now.toISOString() }), "credit offer")) {
      await db.prepare("UPDATE employer_credits SET offer_sent_at = ? WHERE id = ?").bind(now.toISOString(), c.id).run();
    }
  }
}

// No answer in CREDIT_DEFAULT_DAYS: a refund, as the offer said.
async function defaultCredits(db, env, now, fetchImpl) {
  const cutoff = new Date(now.getTime() - CREDIT_DEFAULT_DAYS * 86400e3).toISOString();
  const { results } = await db.prepare("SELECT * FROM employer_credits WHERE status = 'offered' AND offer_sent_at IS NOT NULL AND offer_sent_at < ?").bind(cutoff).all();
  for (const credit of results) {
    try {
      await settleCredit(db, env, credit, "refund", "default", now, fetchImpl);
    } catch (e) {
      console.error("credit default failed:", e && e.name);
    }
  }
}
