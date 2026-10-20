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
import { hex, hmacHex, sameHex, siteUrl, stripe } from "./billing.js";
import { trySend, sendMail } from "./mail.js";

// Prices in cents (Bruce, 2026-10-19: final). public_body is the price for a nonprofit or public body.
export const PRICES = {
  one: { roles: 1, cents: 2900, public_body_cents: 1500 },
  three: { roles: 3, cents: 6900, public_body_cents: 3500 },
};
export const DAYS = 30;              // days each role runs
export const FIELD_CAP = 5;          // paid roles running at once that share a field tag
export const MAX_START_DAYS = 90;    // the start day is today up to this many days ahead
export const PILOT_MAX = 5;          // pilot codes, ever
export const TOKEN_HOURS = 48;       // the email link works this long
export const UNVERIFIED_DAYS = 7;    // an order never confirmed is deleted after this
export const CREDIT_DEFAULT_DAYS = 30;   // an unanswered unused-days offer becomes a refund after this
export const TERMS_VERSION = "2026-10-19";   // docs/terms.html#employers, as the order's clickwrap box shows it
export const MAX_ORDER_BYTES = 4_000;
export const MAX_FORM_BYTES = 4_000;

// A verified order's roles hold their days this long after its Checkout opened (Checkout expires at 31
// minutes), so two buyers can't both pay for the last place in a field.
const CHECKOUT_HOLD_MS = 35 * 60_000;
const CHECKOUT_EXPIRES_S = 31 * 60;
// A Checkout opened this recently is handed out again rather than opening a second one.
const CHECKOUT_REUSE_MS = 30 * 60_000;
const REMIND_AFTER_MS = 24 * 3600e3;
// Orders per network address per UTC day, and from everyone, like the interest form (leads.js).
export const PER_ADDRESS_PER_DAY = 5;
export const ALL_PER_DAY = 100;
const ALL = "order:*";
const ORDERS_SHOWN = 100;
// Where Bruce's review links point. The Worker's own address; API_URL overrides it (wrangler dev).
const DEFAULT_API = "https://internscout-api.bpmcginley.workers.dev";

// The site build drops a placement for these reasons when its role has gone (placement_runs.reason).
export const CLOSE_REASONS = ["listing_gone", "closed", "url_changed", "deadline"];
// Placement statuses that hold days against the field cap.
const HOLDING = ["draft", "checked", "on", "paused"];

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
const SHARD = /^[a-z0-9_]$/;
const LISTING_ID = /^[0-9a-f]{16}$/;
const FIELD = /^[a-z0-9_-]{1,40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ORDER_ID = /^o-[0-9a-f]{16}$/;
const CREDIT_ID = /^c-[0-9a-f]{16}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PILOT = /^[A-Z0-9-]{4,32}$/;
const CONTROL = /[\u0000-\u001F\u007F]/g;
const LIMITS = { name: 100, email: 254, company: 120, pilot_code: 32, reason: 200, note: 200 };

const bad = (field, message) => new HttpError(400, "bad_request", message, { field });
const conflict = (code, message, extra) => new HttpError(409, code, message, extra);
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

const apiUrl = (env) => (env.API_URL || DEFAULT_API).replace(/\/+$/, "");
const money = (cents) => "$" + (Number(cents || 0) / 100).toFixed(2);
const longDay = (day) => new Date(day + "T00:00:00Z").toLocaleDateString("en-US",
  { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
const rolesWord = (n) => (n === 1 ? "1 role" : `${n} roles`);
const randomHex = (bytes) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
const fieldsOf = (list) => (list.length ? list : ["other"]);

function text(body, field, { required = false } = {}) {
  const v = body[field];
  if (v != null && typeof v !== "string") throw bad(field, `${field} must be text`);
  const s = (v || "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (required && !s) throw bad(field, `${field} is required`);
  if (s.length > LIMITS[field]) throw bad(field, `${field} is too long (at most ${LIMITS[field]} characters)`);
  return s;
}

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

// The review link's signature: hex HMAC-SHA256 under ADMIN_TOKEN of "review:" + order id.
export const reviewSig = (env, id) => hmacHex(env.ADMIN_TOKEN, "review:" + id);
async function sigOk(env, id, sig) {
  if (typeof id !== "string" || !ORDER_ID.test(id) || typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return false;
  return sameHex(await reviewSig(env, id), sig);
}

async function addressKey(request, env) {
  if (!env.HASH_SALT) throw new HttpError(500, "server", "Server is missing HASH_SALT");
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return "order:" + (await tokenHash(`order|${ip}|${env.HASH_SALT}`));
}

// ---------------------------------------------------------------- the role index

export const shardOf = (key) => {
  const c = String(key || "").charAt(0);
  return /^[a-z0-9]$/.test(c) ? c : "_";
};

// One role from the index, or null when anything about it is not the shape we expect. The index is our
// own file, but it comes over the network, so nothing in it is trusted to be well formed.
function cleanRole(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const str = (v, max, required = true) => {
    if (v == null && !required) return "";
    if (typeof v !== "string") return null;
    const s = v.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
    return (!s && required) || s.length > max ? null : s;
  };
  const id = typeof r.id === "string" && LISTING_ID.test(r.id) ? r.id : null;
  const k = str(r.k, 120), co = str(r.co, 120), t = str(r.t, 200), loc = str(r.loc, 200, false), u = str(r.u, 2000);
  if (!id || k == null || co == null || t == null || loc == null || u == null) return null;
  try {
    const url = new URL(u);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
  } catch {
    return null;
  }
  const f = Array.isArray(r.f) ? r.f.filter((x) => typeof x === "string" && FIELD.test(x)) : [];
  return { id, k, co, t, loc, u, f: [...new Set(f)].slice(0, 20), unpaid: r.unpaid === true };
}

// The open roles in one shard of the site's role index (backend role_index.py), by id. A shard file
// the site does not have (404) is an empty shard: no employer there has open roles today.
export async function readShard(env, shard, fetchImpl) {
  if (typeof shard !== "string" || !SHARD.test(shard)) throw bad("shard", "shard must be one of a-z, 0-9 or _");
  let res, data = null;
  try {
    // The site's file changes once per build; a few minutes of edge cache spares GitHub Pages.
    res = await fetchImpl(`${siteUrl(env)}/data/roles/${shard}.json`, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (res.status === 404) return new Map();
    if (res.ok) data = await res.json();
  } catch {}
  if (!data || typeof data !== "object" || !Array.isArray(data.roles)) {
    throw new HttpError(502, "roles_unavailable", "The list of open roles can't be read right now. Please try again in a few minutes.");
  }
  const roles = new Map();
  for (const r of data.roles.slice(0, 20_000)) {
    const c = cleanRole(r);
    if (c && !roles.has(c.id)) roles.set(c.id, c);
  }
  return roles;
}

// ---------------------------------------------------------------- the field cap

// Every paid role that holds days, other than `exceptOrder`'s: { listing, fields, start, end } (end
// exclusive). Paid and approved orders hold the days of their placements while those are draft, checked,
// on or paused (or the order's own days if its placements are not made yet); a verified order holds its
// days for CHECKOUT_HOLD_MS after its Checkout opened.
async function heldRoles(db, now, exceptOrder = "") {
  const cutoff = new Date(now.getTime() - CHECKOUT_HOLD_MS).toISOString();
  const { results } = await db.prepare(
    "SELECT r.listing_id, r.fields, o.status, o.start_day, p.status AS p_status, p.start_day AS p_start, p.end_day AS p_end " +
    "FROM employer_order_roles r JOIN employer_orders o ON o.id = r.order_id LEFT JOIN placements p ON p.id = r.placement_id " +
    "WHERE o.id != ? AND (o.status IN ('paid', 'approved') OR (o.status = 'verified' AND o.checkout_at > ?))",
  ).bind(exceptOrder, cutoff).all();
  const held = [];
  for (const r of results) {
    const fields = fieldsOf(String(r.fields || "").split(",").filter(Boolean));
    if (r.p_status) {
      if (HOLDING.includes(r.p_status)) held.push({ listing: r.listing_id, fields, start: r.p_start, end: r.p_end });
    } else if (r.status !== "approved") {
      held.push({ listing: r.listing_id, fields, start: r.start_day, end: addDays(r.start_day, DAYS) });
    }
  }
  return held;
}

// What stops one role running DAYS days from `start` alongside `held`: the fields that would go over
// FIELD_CAP on some day, and whether the same role is already paid for on one of those days.
function clash(held, role, start) {
  const end = addDays(start, DAYS);
  const near = held.filter((h) => h.start < end && start < h.end);
  const full = new Set();
  let taken = false;
  for (let d = start; d < end; d = addDays(d, 1)) {
    const on = near.filter((h) => h.start <= d && d < h.end);
    if (on.some((h) => h.listing === role.id)) taken = true;
    for (const f of role.fields) if (on.filter((h) => h.fields.includes(f)).length >= FIELD_CAP) full.add(f);
  }
  return { taken, full: [...full] };
}

// The roles of one order together (three roles that share a field count against each other).
function fitAll(held, roles, start) {
  const mine = [...held];
  const out = [];
  for (const role of roles) {
    const c = clash(mine, role, start);
    out.push({ id: role.id, fits: !c.taken && !c.full.length, ...(c.full.length ? { full: c.full } : {}), ...(c.taken ? { taken: true } : {}) });
    mine.push({ listing: role.id, fields: role.fields, start, end: addDays(start, DAYS) });
  }
  return { fits: out.every((r) => r.fits), roles: out };
}

// The first day from `start` on which the roles fit. Moving the start later only helps on a day some
// held role ends, so the answer is `start` or one of those end days; nothing else needs trying.
function firstFit(held, roles, start) {
  const ends = [...new Set(held.map((h) => h.end).filter((e) => e > start))].sort();
  for (const day of [start, ...ends]) if (fitAll(held, roles, day).fits) return day;
  return null;
}

// The most paid roles in one field on any single day from start to end (for the review page).
function busiest(held, field, start, end) {
  let max = 0;
  for (let d = start; d < end; d = addDays(d, 1)) {
    max = Math.max(max, held.filter((h) => h.start <= d && d < h.end && h.fields.includes(field)).length);
  }
  return max;
}

function startDay(v, today, field = "start") {
  if (typeof v !== "string" || !DAY.test(v) || Number.isNaN(Date.parse(v + "T00:00:00Z"))
      || new Date(v + "T00:00:00Z").toISOString().slice(0, 10) !== v) {
    throw bad(field, `${field} must be a day as YYYY-MM-DD`);
  }
  if (v < today || v > addDays(today, MAX_START_DAYS)) {
    throw bad(field, `The start day must be from today up to ${MAX_START_DAYS} days ahead`);
  }
  return v;
}

// GET /employer/availability?shard=&ids=&start=: per role, whether it fits from `start` (default today),
// or the fields that are full and the first day it would fit. Each role on its own.
export async function availability(db, env, params, now, fetchImpl) {
  const today = dayOf(now);
  const start = params.get("start") ? startDay(params.get("start"), today) : today;
  const ids = String(params.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length || ids.length > 20 || ids.some((id) => !LISTING_ID.test(id))) {
    throw bad("ids", "ids must be 1 to 20 role ids, comma separated");
  }
  const index = await readShard(env, params.get("shard"), fetchImpl);
  const held = await heldRoles(db, now);
  return {
    start,
    roles: [...new Set(ids)].map((id) => {
      const r = index.get(id);
      if (!r) return { id, listed: false };
      const role = { id, fields: fieldsOf(r.f) };
      const fit = fitAll(held, [role], start).roles[0];
      return fit.fits ? { id, listed: true, fits: true } : { ...fit, listed: true, next_start: firstFit(held, [role], start) };
    }),
  };
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
    terms_version: TERMS_VERSION, terms_at: at, token_hash: await tokenHash(token),
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
    const r = await db.prepare("UPDATE pilot_codes SET order_id = ?, used_at = ? WHERE code = ? AND order_id IS NULL")
      .bind(order.id, at, order.pilot_code).run();
    if (!r.meta.changes) {
      throw conflict("pilot_used", "That pilot code has been used since you ordered. Please start a new order without it.");
    }
    await markPaid(db, env, { ...order, status: "verified" },
      { ref: "pilot:" + order.pilot_code, amount: 0, pi: null, session: null }, now);
    return { done: "pilot" };
  }

  if (order.checkout_url && order.checkout_at && now.getTime() - Date.parse(order.checkout_at) < CHECKOUT_REUSE_MS) {
    return { url: order.checkout_url };
  }
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
  await settle(db, env, fresh, now);
  await trySend(env, receivedMail(env, fresh, await orderRoles(db, fresh.id)), "order received");
  return true;
}

// What a paid order needs and may not have yet: its draft placements and Bruce's review email. Safe to
// run again (a Stripe retry, the daily cron).
async function settle(db, env, order, now) {
  if (order.status !== "paid") return;
  await ensurePlacements(db, order, now);
  if (!order.review_sent_at) await sendReview(db, env, order, now);
}

// One draft placement per role (placements.js createPlacement, created_by "checkout"), made once.
async function ensurePlacements(db, order, now) {
  for (const role of await orderRoles(db, order.id)) {
    if (role.placement_id) continue;
    const p = await createPlacement(db, {
      employer: role.company, listing_id: role.listing_id, apply_url: role.apply_url,
      start: order.start_day, end: addDays(order.start_day, DAYS), note: `order ${order.id}`, by: "checkout",
    }, now);
    await db.prepare("UPDATE employer_order_roles SET placement_id = ? WHERE order_id = ? AND listing_id = ? AND placement_id IS NULL")
      .bind(p.id, order.id, role.listing_id).run();
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
  await db.prepare("UPDATE employer_orders SET disputed_at = ?, updated = ? WHERE id = ?")
    .bind(now.toISOString(), now.toISOString(), order.id).run();
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
      row("Terms accepted", `${esc(order.terms_version)} at ${esc(order.terms_at)}`),
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
  try {
    if (action === "approve") {
      if (order.disputed_at) return message("Not approved", "A payment dispute is open on this order, so it was not approved.", 409);
      const dates = await approve(db, env, order, now);
      return message("Approved", `Order ${id} is approved. Its roles run ${dates}. The employer has been emailed.`);
    }
    if (action === "refuse") {
      const reason = text({ reason: form.get("reason") }, "reason", { required: true });
      const refunded = await refuse(db, env, order, reason, now, fetchImpl);
      return message("Refused", `Order ${id} is refused. ${refunded ? `${money(refunded)} was refunded. ` : ""}The employer has been emailed the reason.`);
    }
  } catch (e) {
    if (e instanceof HttpError) return message("Not done", e.message, e.status);
    throw e;
  }
  return message("Not done", "Choose Approve or Refuse.", 400);
}

// The same steps Bruce runs by hand, by "bruce", each one skipped if it is already done, so a second
// click after a failure finishes the job. Returns the dates as text for the page.
async function approve(db, env, order, now) {
  await ensurePlacements(db, order, now);
  const today = dayOf(now);
  const roles = await orderRoles(db, order.id);
  const done = [];
  for (const role of roles) {
    let p = await db.prepare("SELECT * FROM placements WHERE id = ?").bind(role.placement_id).first();
    if (["draft", "checked"].includes(p.status) && p.start_day < today) {
      // No paid day is lost to the review: the 30 days start on the day of approval.
      p = await updatePlacement(db, { id: p.id, by: "bruce", start: today, end: addDays(today, DAYS) }, now);
    }
    if (p.status === "draft") {
      p = await checkPlacement(db, { id: p.id, by: "bruce", checks: CHECKS, unpaid_ok: !!(role.unpaid && order.public_body) }, now);
    }
    if (p.status === "checked") p = await switchOn(db, { id: p.id, by: "bruce", paid_ref: order.paid_ref }, now);
    if (p.status !== "on") throw conflict("conflict", `Placement ${p.id} is ${p.status}, so it was not switched on.`);
    done.push({ role, p });
  }
  const at = now.toISOString();
  await db.prepare("UPDATE employer_orders SET status = 'approved', decided_at = ?, updated = ? WHERE id = ? AND status = 'paid'")
    .bind(at, at, order.id).run();
  await trySend(env, approvedMail(env, order, done), "approved");
  const spans = [...new Set(done.map(({ p }) => `${p.start_day} to ${addDays(p.end_day, -1)}`))];
  return spans.join(", ");
}

// Refund first (one idempotency key per order, so a second click never refunds twice), then the records.
async function refuse(db, env, order, reason, now, fetchImpl) {
  let refund = null;
  if (order.payment_intent && order.paid_amount > 0) {
    refund = await stripe(env, "refunds", { payment_intent: order.payment_intent, "metadata[order]": order.id, "metadata[why]": "refused" },
      fetchImpl, `listing-refund:${order.id}`);
  }
  for (const role of await orderRoles(db, order.id)) {
    if (!role.placement_id) continue;
    const p = await db.prepare("SELECT status FROM placements WHERE id = ?").bind(role.placement_id).first();
    if (p && ["draft", "checked"].includes(p.status)) await refusePlacement(db, { id: role.placement_id, by: "bruce", reason }, now);
  }
  const at = now.toISOString();
  const amount = refund ? (Number.isSafeInteger(refund.amount) ? refund.amount : order.paid_amount) : 0;
  await db.batch([
    db.prepare("UPDATE employer_orders SET status = 'refused', decided_at = ?, decided_reason = ?, refund_id = ?, " +
      "refunded_amount = ?, updated = ? WHERE id = ? AND status = 'paid'")
      .bind(at, reason, refund ? String(refund.id || "") : null, amount, at, order.id),
    // A refused pilot does not use up one of the five.
    db.prepare("UPDATE pilot_codes SET order_id = NULL, used_at = NULL WHERE order_id = ?").bind(order.id),
  ]);
  await trySend(env, refusedMail(env, order, reason, amount), "refused");
  return amount;
}

// ---------------------------------------------------------------- 5. a role closes early

// GET /employer/credit?credit=&t=: the offer, for the buy page to show.
export async function creditInfo(db, params, now) {
  const credit = await loadCredit(db, params.get("credit"), params.get("t"));
  const role = await db.prepare("SELECT title, company FROM employer_order_roles WHERE placement_id = ?").bind(credit.placement_id).first();
  return {
    credit: credit.id, status: credit.status, amount: credit.amount, unused_days: credit.unused_days,
    role: role ? { title: role.title, company: role.company } : null,
    choose_by: addDays(credit.created.slice(0, 10), CREDIT_DEFAULT_DAYS),
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
  if (!done) throw conflict("decided", "This was decided a moment ago. Please reload the page.");
  return body.choice === "refund" ? { done: "refund", amount: credit.amount } : { done: "credit", code: done.code, amount: credit.amount };
}

// Claims the offer first (offered -> the choice), so two clicks, or a click and the cron, can't both
// act; then Stripe; and if Stripe fails, the offer goes back to `offered` for another try.
async function settleCredit(db, env, credit, choice, who, now, fetchImpl) {
  const at = now.toISOString();
  const claim = await db.prepare("UPDATE employer_credits SET status = ?, chosen_at = ?, chosen_by = ?, updated = ? WHERE id = ? AND status = 'offered'")
    .bind(choice, at, who, at, credit.id).run();
  if (!claim.meta.changes) return null;
  const order = await db.prepare("SELECT * FROM employer_orders WHERE id = ?").bind(credit.order_id).first();
  try {
    if (choice === "refund") {
      const refund = await stripe(env, "refunds", { payment_intent: order.payment_intent, amount: String(credit.amount),
        "metadata[order]": order.id, "metadata[credit]": credit.id, "metadata[why]": "role_closed" }, fetchImpl, `listing-credit-refund:${credit.id}`);
      await db.prepare("UPDATE employer_credits SET refund_id = ? WHERE id = ?").bind(String(refund.id || ""), credit.id).run();
      await trySend(env, creditMail(env, order, credit, who === "default" ? "default" : "refund"), "credit refund");
      return { refund: refund.id };
    }
    // A one-time code worth the amount. Restricted to orders of at least the smallest listing price, so
    // it can't be spent on a student plan, whose Checkout also takes promotion codes.
    const coupon = await stripe(env, "coupons", { amount_off: String(credit.amount), currency: "usd", duration: "once",
      max_redemptions: "1", name: "InternScout listing credit", "metadata[credit]": credit.id }, fetchImpl, `listing-coupon:${credit.id}`);
    const promo = await stripe(env, "promotion_codes", { "promotion[type]": "coupon", "promotion[coupon]": String(coupon.id),
      max_redemptions: "1", "restrictions[minimum_amount]": String(PRICES.one.public_body_cents),
      "restrictions[minimum_amount_currency]": "usd", "metadata[credit]": credit.id }, fetchImpl, `listing-promo:${credit.id}`);
    const code = String(promo.code || "");
    await db.prepare("UPDATE employer_credits SET promotion_code = ? WHERE id = ?").bind(code, credit.id).run();
    await trySend(env, creditMail(env, order, { ...credit, promotion_code: code }, "credit"), "credit code");
    return { code };
  } catch (e) {
    await db.prepare("UPDATE employer_credits SET status = 'offered', chosen_at = NULL, chosen_by = NULL WHERE id = ? AND status = ?")
      .bind(credit.id, choice).run();
    throw e;
  }
}

// ---------------------------------------------------------------- the daily cron

export async function ordersCron(db, env, now, fetchImpl = (...a) => fetch(...a)) {
  await dropUnverifiedOrders(db, now);
  if (!ordersOn(env)) return;
  for (const job of [resendReviews, remindReviews, closeRoles, resendOffers, defaultCredits]) {
    try {
      await job(db, env, now, fetchImpl);
    } catch (e) {
      console.error("orders cron failed:", job.name, e && e.name);
    }
  }
}

// An order never confirmed is deleted after UNVERIFIED_DAYS (docs/privacy.html#employers).
export async function dropUnverifiedOrders(db, now) {
  const cutoff = new Date(now.getTime() - UNVERIFIED_DAYS * 86400e3).toISOString();
  await db.batch([
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
    "JOIN placements p ON p.id = r.placement_id WHERE p.status = 'on' AND p.start_day <= ?",
  ).bind(d2).all();
  for (const r of results) {
    const runs = (await db.prepare("SELECT day, shown, dropped, reason FROM placement_runs WHERE placement_id = ? AND day <= ? ORDER BY day DESC")
      .bind(r.placement_id, d1).all()).results;
    const byDay = Object.fromEntries(runs.map((x) => [x.day, x]));
    if (!closedDay(byDay[d1]) || !closedDay(byDay[d2])) continue;
    let first = d2;
    while (first > r.start_day && closedDay(byDay[addDays(first, -1)])) first = addDays(first, -1);
    try {
      await endPlacement(db, { id: r.placement_id, by: "cron", reason: "role_closed" }, now);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      continue;   // changed by hand at the same moment: left for tomorrow
    }
    const order = await db.prepare("SELECT * FROM employer_orders WHERE id = ?").bind(r.order_id).first();
    const count = (await db.prepare("SELECT COUNT(*) AS n FROM employer_order_roles WHERE order_id = ?").bind(r.order_id).first("n")) || 1;
    const unused = Math.max(0, Math.min(DAYS, daysBetween(first, r.end_day)));
    const amount = Math.round((unused * (Number(order.paid_amount) || 0)) / Number(count) / DAYS);
    if (!(amount > 0) || !order.payment_intent) {
      await trySend(env, closedMail(env, order, r, first, unused, 0, null), "role closed");
      continue;
    }
    const token = newToken();
    const credit = { id: "c-" + randomHex(8), order_id: order.id, placement_id: r.placement_id, created: now.toISOString(),
      amount, unused_days: unused, token_hash: await tokenHash(token), status: "offered", updated: now.toISOString() };
    const cols = Object.keys(credit);
    await db.prepare(`INSERT OR IGNORE INTO employer_credits (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .bind(...cols.map((c) => credit[c])).run();
    if (await trySend(env, closedMail(env, order, r, first, unused, amount, { ...credit, token }), "credit offer")) {
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
    if (await trySend(env, closedMail(env, order, { title: c.title }, first, c.unused_days, c.amount, { ...c, token }), "credit offer")) {
      await db.prepare("UPDATE employer_credits SET offer_sent_at = ? WHERE id = ?").bind(now.toISOString(), c.id).run();
    }
  }
}

// No answer in CREDIT_DEFAULT_DAYS: a refund, as the offer said.
async function defaultCredits(db, env, now, fetchImpl) {
  const cutoff = new Date(now.getTime() - CREDIT_DEFAULT_DAYS * 86400e3).toISOString();
  const { results } = await db.prepare("SELECT * FROM employer_credits WHERE status = 'offered' AND created < ?").bind(cutoff).all();
  for (const credit of results) {
    try {
      await settleCredit(db, env, credit, "refund", "default", now, fetchImpl);
    } catch (e) {
      console.error("credit default failed:", e && e.name);
    }
  }
}

// ---------------------------------------------------------------- admin (Bruce's terminal)

// GET /admin/orders: the recent orders, without the employer's name or email.
export async function listOrders(db) {
  const { results } = await db.prepare(
    "SELECT o.id, o.created, o.status, o.package, o.start_day AS start, COALESCE(o.paid_amount, o.price) AS amount, " +
    "o.company, (SELECT COUNT(*) FROM employer_order_roles r WHERE r.order_id = o.id) AS roles " +
    "FROM employer_orders o ORDER BY o.created DESC, o.id LIMIT ?",
  ).bind(ORDERS_SHOWN).all();
  return { orders: results };
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// POST /admin/pilot-codes { note? }: a new pilot code, while fewer than PILOT_MAX have ever been made.
// The count and the insert are one statement, so two at once can't make a sixth.
export async function createPilotCode(db, body, now) {
  const note = text(body, "note");
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const code = "PILOT-" + [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
  const r = await db.prepare(
    "INSERT INTO pilot_codes (code, created, note) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM pilot_codes) < ?",
  ).bind(code, now.toISOString(), note, PILOT_MAX).run();
  if (!r.meta.changes) throw conflict("conflict", `All ${PILOT_MAX} pilot codes have been made`);
  const made = await db.prepare("SELECT COUNT(*) AS n FROM pilot_codes").first("n");
  return { code, note, created: now.toISOString(), made: Number(made), max: PILOT_MAX };
}

// ---------------------------------------------------------------- the emails (plain text)

const sign = (env) => `\nInternScout\n${siteUrl(env)}\n`;
const roleList = (roles) => roles.map((r) => `- ${r.title || r.t}${(r.location || r.loc) ? ", " + (r.location || r.loc) : ""}`).join("\n");

function verifyMail(env, order, roles, token) {
  const link = `${siteUrl(env)}/employers/buy/?order=${order.id}&t=${token}`;
  return {
    to: order.email, replyTo: env.REVIEW_TO,
    subject: "Confirm your InternScout listing order",
    text: `Hello ${order.name},\n\nYou asked to list ${rolesWord(roles.length)} from ${order.employer} on InternScout for ` +
      `${DAYS} days from ${longDay(order.start_day)}:\n\n${roleList(roles)}\n\n` +
      (order.pilot_code
        ? "You entered a pilot code, so there is nothing to pay. Open this link within 48 hours to confirm the order:\n"
        : `To confirm this address and go on to payment (${money(order.price)}), open this link within 48 hours:\n`) +
      `${link}\n\nIf you did not ask for this, ignore this email. Nothing is charged, and the order is deleted after ` +
      `${UNVERIFIED_DAYS} days.\n${sign(env)}`,
  };
}

function receivedMail(env, order, roles) {
  return {
    to: order.email, replyTo: env.REVIEW_TO,
    subject: `We have your InternScout listing order ${order.id}`,
    text: `Hello ${order.name},\n\nWe have your order ${order.id}: ${rolesWord(roles.length)} from ${order.employer}, ` +
      `${DAYS} days each from ${longDay(order.start_day)}.\n\n${roleList(roles)}\n\n` +
      (order.pilot_code ? "This is a pilot order, so there is nothing to pay.\n\n"
        : `You paid ${money(order.paid_amount)}. Stripe emails your receipt and invoice separately.\n\n`) +
      "We review every order within 2 business days and email you when it is approved. If we can't list a role, " +
      "we refund the full amount and tell you why.\n\nIf you have a question, reply to this email.\n" + sign(env),
  };
}

async function reviewMail(env, order, roles, reminder) {
  const link = `${apiUrl(env)}/employer/review?order=${order.id}&sig=${await reviewSig(env, order.id)}`;
  return {
    to: env.REVIEW_TO,
    subject: `${reminder ? "Reminder: still waiting, " : "Review "}listing order ${order.id}: ${order.employer}`,
    text: (reminder ? `Order ${order.id} has waited more than a day for your decision.\n\n` : `Order ${order.id} waits for your decision.\n\n`) +
      `Employer (role index): ${order.employer}\nCompany typed: ${order.company}\nContact: ${order.name}, ${order.email} ` +
      `(domain ${order.email_domain})\nNonprofit or public body: ${order.public_body ? "yes, claimed" : "no"}\n` +
      `Package: ${order.package}, ${rolesWord(roles.length)}\nPaid: ${money(order.paid_amount)} (${order.paid_ref})\n` +
      `Start: ${order.start_day}\n\nRoles:\n${roles.map((r) => `- ${r.title}: ${r.apply_url}`).join("\n")}\n\n` +
      `Approve or refuse here:\n${link}\n`,
  };
}

function approvedMail(env, order, done) {
  return {
    to: order.email, replyTo: env.REVIEW_TO,
    subject: `Your InternScout listing order ${order.id} is approved`,
    text: `Hello ${order.name},\n\nYour order ${order.id} is approved. These roles show in a separate, labelled box on ` +
      "InternScout on these days (UTC):\n\n" +
      done.map(({ role, p }) => `- ${role.title}: ${longDay(p.start_day)} through ${longDay(addDays(p.end_day, -1))}`).join("\n") +
      "\n\nThey appear once the site next updates. Paying does not change where any listing ranks or how it is scored. " +
      "If a role closes early, we email you about its unused days.\n" + sign(env),
  };
}

function refusedMail(env, order, reason, refunded) {
  return {
    to: order.email, replyTo: env.REVIEW_TO,
    subject: `Your InternScout listing order ${order.id}`,
    text: `Hello ${order.name},\n\nWe are not able to list order ${order.id}. The reason: ${reason}\n\n` +
      (refunded > 0
        ? `We refunded the full amount, ${money(refunded)}, to the card you paid with. Stripe says a refund usually shows within 5 to 10 business days.\n\n`
        : order.pilot_code ? "This was a pilot order, so there was nothing to pay or refund. Your pilot code can be used again.\n\n"
        : "Nothing was charged, so there is nothing to refund.\n\n") +
      "If you have a question, reply to this email.\n" + sign(env),
  };
}

function closedMail(env, order, role, first, unused, amount, credit) {
  const head = `Hello ${order.name},\n\n${role.title} (order ${order.id}) stopped appearing on InternScout on ${longDay(first)}, ` +
    "because the posting closed, moved to a new address or passed its deadline. So its paid listing has ended.\n\n";
  if (!credit) {
    return { to: order.email, replyTo: env.REVIEW_TO, subject: "Your InternScout listing has ended early",
      text: head + (order.pilot_code ? "It was a pilot listing, so there is nothing to refund.\n" : "There is nothing left to refund.\n") +
        "\nIf the role is open again at a new address, reply to this email.\n" + sign(env) };
  }
  const link = `${siteUrl(env)}/employers/buy/?credit=${credit.id}&t=${credit.token}`;
  const by = longDay(addDays(credit.created.slice(0, 10), CREDIT_DEFAULT_DAYS));
  return {
    to: order.email, replyTo: env.REVIEW_TO,
    subject: "Your InternScout listing ended early: choose a refund or a credit",
    text: head + `${unused} of its ${DAYS} days were not used. They are worth ${money(amount)}. You can choose:\n\n` +
      `- a refund of ${money(amount)} to the card you paid with, or\n- a one-time promotion code worth ${money(amount)} for a future listing order.\n\n` +
      `Choose here: ${link}\n\nIf you do not choose by ${by}, we refund it.\n` + sign(env),
  };
}

function creditMail(env, order, credit, kind) {
  const text = kind === "credit"
    ? `Your promotion code is ${credit.promotion_code}\n\nIt is worth ${money(credit.amount)} off one future InternScout listing ` +
      "order and works once. Enter it on the Stripe payment page.\n"
    : (kind === "default" ? `You did not choose within ${CREDIT_DEFAULT_DAYS} days, so we refunded the unused days. ` : "") +
      `We refunded ${money(credit.amount)} to the card you paid with. Stripe says a refund usually shows within 5 to 10 business days.\n`;
  return {
    to: order.email, replyTo: env.REVIEW_TO,
    subject: kind === "credit" ? "Your InternScout promotion code" : "We refunded your unused InternScout listing days",
    text: `Hello ${order.name},\n\n${text}` + sign(env),
  };
}
