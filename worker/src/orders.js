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
import { CHECKS, addDays, checkPlacement, dayOf, daysBetween, endPlacement, pausePlacement,
  refusePlacement, switchOn, updatePlacement } from "./placements.js";
import { hex, sameHex, siteUrl, stripe } from "./billing.js";
import { trySend, sendMail } from "./mail.js";
import { queueOrderMail, retryOrderMail, dropRetainedOrders } from "./order-mail.js";
import { CHECKOUT_HOLD_MS, CREDIT_DEFAULT_DAYS, DAYS, FIELD_CAP, LIMITS, LISTING_ID, MAX_START_DAYS, ORDER_ID, PRICES, UNVERIFIED_DAYS, bad, conflict, fieldsOf, money, rolesWord, text } from "./orders/shared.js";
import { readShard, shardOf } from "./orders/roles.js";
import { busiest, fillPlacementFields, firstFit, fitAll, heldRoles, reserveCapacity, startDay } from "./orders/capacity.js";
import { approvedMail, closedMail, creditMail, refusedMail, reviewSig, verifyMail } from "./orders/templates.js";
import { loadOrder, orderRoles } from "./orders/records.js";
import { esc, message, page } from "./orders/review-html.js";
import { ensurePlacements, markPaid, sendReview, settle } from "./orders/settlement.js";
import { addressKey, newToken, ordersOn, randomHex, sigOk, siteOnly, tokenHash, tokenOk } from "./orders/access.js";

export { listOrders } from "./orders/admin.js";
export { PILOT_MAX, createPilotCode } from "./orders/pilot.js";
export { readShard, shardOf } from "./orders/roles.js";
export { availability, notePlacementFields } from "./orders/capacity.js";
export { CREDIT_DEFAULT_DAYS, DAYS, FIELD_CAP, MAX_START_DAYS, PRICES, UNVERIFIED_DAYS } from "./orders/shared.js";
export { TERMS_ARCHIVE, reviewSig } from "./orders/templates.js";
export { listingEvent } from "./orders/settlement.js";
export { MAX_FORM_BYTES, reviewDecision, reviewPage } from "./orders/review.js";
export { ALL_PER_DAY, PER_ADDRESS_PER_DAY, TOKEN_HOURS, WEBMAIL, checkoutForm, confirmOrder, takeOrder } from "./orders/checkout.js";
export { newToken, ordersOn, tokenHash } from "./orders/access.js";

// The terms an order accepts: docs/terms.html's "Last updated" day (tests/site/buy.test.mjs holds the two
// together), and the clickwrap box exactly as docs/employers/buy/ shows it, stored on every order (legal
// review round 4, 2026-10-19). was: "2026-10-19", and only the version was stored.
export const TERMS_VERSION = "2026-10-20";
export const TERMS_BOX = "I have read and accept the InternScout terms, including the section for employers, on behalf of my company, and I am authorized to accept them for it.";
export const MAX_ORDER_BYTES = 4_000;

const REMIND_AFTER_MS = 24 * 3600e3;
// The site build drops a placement for these reasons when its role has gone (placement_runs.reason).
export const CLOSE_REASONS = ["listing_gone", "closed", "url_changed", "deadline"];

const CREDIT_ID = /^c-[0-9a-f]{16}$/;

const notFound = () => new HttpError(404, "not_found", "No such endpoint");

// ---------------------------------------------------------------- on or off

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
