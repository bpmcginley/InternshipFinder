import { HttpError } from "../http.js";
import { bumpUnder } from "../limits.js";
import { EMAIL, isBot } from "../leads.js";
import { dayOf } from "../placements.js";
import { siteUrl, stripe } from "../billing.js";
import { sendMail } from "../mail.js";
import { TERMS_BOX, TERMS_VERSION } from "../orders.js";
import { CHECKOUT_HOLD_MS, DAYS, LISTING_ID, PRICES, bad, conflict, fieldsOf, rolesWord, text } from "./shared.js";
import { readShard } from "./roles.js";
import { firstFit, fitAll, heldRoles, reserveCapacity, startDay } from "./capacity.js";
import { verifyMail } from "./templates.js";
import { loadOrder, orderRoles } from "./records.js";
import { markPaid } from "./settlement.js";
import { addressKey, newToken, randomHex, siteOnly, tokenHash, tokenOk } from "./access.js";

export const TOKEN_HOURS = 48;       // the email link works this long
const CHECKOUT_EXPIRES_S = 31 * 60;
// A Checkout opened this recently is handed out again rather than opening a second one.
const CHECKOUT_REUSE_MS = 30 * 60_000;

// Orders per network address per UTC day, and from everyone, like the interest form (leads.js).
export const PER_ADDRESS_PER_DAY = 5;
export const ALL_PER_DAY = 100;
const ALL = "order:*";

// Free webmail domains. The terms say "you write from your company's domain".
export const WEBMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com",
  "yahoo.com", "yahoo.co.uk", "ymail.com", "rocketmail.com", "aol.com", "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "gmx.de", "web.de", "mail.com", "zoho.com",
  "zohomail.com", "yandex.com", "yandex.ru", "tutanota.com", "tuta.io", "fastmail.com", "hey.com", "qq.com",
  "163.com", "126.com", "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "duck.com",
]);

const PILOT = /^[A-Z0-9-]{4,32}$/;

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
