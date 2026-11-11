import { addDays, dayOf, daysBetween, endPlacement } from "../placements.js";
import { trySend } from "../mail.js";
import { dropRetainedOrders, retryOrderMail } from "../order-mail.js";
import { CREDIT_DEFAULT_DAYS, DAYS, UNVERIFIED_DAYS } from "./shared.js";
import { fillPlacementFields } from "./capacity.js";
import { closedMail } from "./templates.js";
import { orderRoles } from "./records.js";
import { sendReview, settle } from "./settlement.js";
import { newToken, ordersOn, randomHex, tokenHash } from "./access.js";
import { settleCredit } from "./refunds.js";

const REMIND_AFTER_MS = 24 * 3600e3;

// The site build drops a placement for these reasons when its role has gone (placement_runs.reason).
export const CLOSE_REASONS = ["listing_gone", "closed", "url_changed", "deadline"];


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
