// Durable transactional order emails. Receipt and decision messages survive provider outages;
// successful messages keep a small idempotency tombstone, with their addresses and content erased.
import { trySend } from "./mail.js";

const KINDS = new Set(["receipt", "approved", "refused"]);
const LEASE_MS = 5 * 60_000;
const BATCH_SIZE = 100;

async function deliver(db, env, orderId, kind, now) {
  const at = now.toISOString();
  const row = await db.prepare("SELECT * FROM employer_order_mail WHERE order_id = ? AND kind = ?")
    .bind(orderId, kind).first();
  if (!row) return false;
  if (row.sent_at) return true;
  const lease = new Date(now.getTime() + LEASE_MS).toISOString();
  const claim = await db.prepare("UPDATE employer_order_mail SET sending_until = ?, attempted_at = ?, attempts = attempts + 1 " +
    "WHERE order_id = ? AND kind = ? AND sent_at IS NULL AND (sending_until IS NULL OR sending_until <= ?)")
    .bind(lease, at, orderId, kind, at).run();
  if (!claim.meta.changes) return false;
  const sent = await trySend(env, { to: row.to_address, subject: row.subject, text: row.body,
    ...(row.reply_to ? { replyTo: row.reply_to } : {}) }, `order ${kind}`);
  if (sent) {
    await db.prepare("UPDATE employer_order_mail SET sent_at = ?, sending_until = NULL, to_address = NULL, " +
      "subject = NULL, body = NULL, reply_to = NULL WHERE order_id = ? AND kind = ? AND sending_until = ?")
      .bind(at, orderId, kind, lease).run();
  } else {
    await db.prepare("UPDATE employer_order_mail SET sending_until = NULL WHERE order_id = ? AND kind = ? AND sending_until = ?")
      .bind(orderId, kind, lease).run();
  }
  return sent;
}

// Persist before sending. Repeated webhook/decision attempts cannot overwrite a previously queued
// message or resend one whose acceptance has already been recorded. Returns true for an accepted send.
// A process dying after provider acceptance but before the sent marker can still cause a duplicate;
// the durable queue provides retries, not an impossible exactly-once delivery guarantee.
export async function queueOrderMail(db, env, { orderId, kind, mail }, now) {
  if (!KINDS.has(kind)) throw new Error("Unknown order email kind");
  if (typeof orderId !== "string" || !/^o-[0-9a-f]{16}$/.test(orderId)) throw new Error("Invalid order id");
  if (!mail || typeof mail.to !== "string" || typeof mail.subject !== "string" || typeof mail.text !== "string" ||
      (mail.replyTo != null && typeof mail.replyTo !== "string")) throw new Error("Invalid order email");
  await db.prepare("INSERT OR IGNORE INTO employer_order_mail (order_id, kind, created, to_address, subject, body, reply_to) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?)").bind(orderId, kind, now.toISOString(), mail.to, mail.subject, mail.text, mail.replyTo || null).run();
  return deliver(db, env, orderId, kind, now);
}

// Called by the existing orders cron. A crashed attempt becomes eligible once its short lease ends.
export async function retryOrderMail(db, env, now) {
  const { results } = await db.prepare("SELECT order_id, kind FROM employer_order_mail WHERE sent_at IS NULL " +
    "AND (sending_until IS NULL OR sending_until <= ?) ORDER BY created LIMIT ?")
    .bind(now.toISOString(), BATCH_SIZE).all();
  let sent = 0;
  for (const row of results) {
    if (await deliver(db, env, row.order_id, row.kind, now)) sent++;
  }
  return { attempted: results.length, sent };
}

// Confirmed business records expire seven calendar years after payment (or confirmation if unpaid).
// The financial safety integration adds the three referenced reservation/decision/credit-job tables.
// Placements and anonymous totals contain no order contact data and keep their existing retention.
export async function dropRetainedOrders(db, now) {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 7);
  const expired = "SELECT id FROM employer_orders WHERE status != 'unverified' AND " +
    "COALESCE(paid_at, verified_at, created) < ?";
  const creditIds = `SELECT id FROM employer_credits WHERE order_id IN (${expired})`;
  await db.batch([
    db.prepare(`DELETE FROM employer_credit_jobs WHERE credit_id IN (${creditIds})`).bind(cutoff.toISOString()),
    db.prepare(`DELETE FROM employer_credits WHERE order_id IN (${expired})`).bind(cutoff.toISOString()),
    db.prepare(`DELETE FROM employer_capacity_reservations WHERE order_id IN (${expired})`).bind(cutoff.toISOString()),
    db.prepare(`DELETE FROM employer_decisions WHERE order_id IN (${expired})`).bind(cutoff.toISOString()),
    db.prepare(`DELETE FROM employer_order_mail WHERE order_id IN (${expired})`).bind(cutoff.toISOString()),
    db.prepare(`DELETE FROM employer_order_roles WHERE order_id IN (${expired})`).bind(cutoff.toISOString()),
    db.prepare(`UPDATE pilot_codes SET order_id = NULL, used_at = NULL WHERE order_id IN (${expired})`).bind(cutoff.toISOString()),
    db.prepare(`DELETE FROM employer_orders WHERE id IN (${expired})`).bind(cutoff.toISOString()),
  ]);
}
