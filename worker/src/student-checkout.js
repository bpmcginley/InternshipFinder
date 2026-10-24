// 2026-10-23: one durable checkout attempt per student, across plans and request retries (W2).
// was: ten-minute, per-plan Stripe keys allowed multiple payable sessions.
// Revert: restore checkout()'s old key, but retain unresolved attempts until reconciled.
import { HttpError } from "./http.js";

const busy = () => new HttpError(409, "checkout_pending", "You already have a checkout in progress. Finish that checkout or wait for it to expire before choosing another plan.");
const held = (db, user) => db.prepare("SELECT * FROM student_checkouts WHERE user_hash = ?").bind(user).first();

export async function studentCheckout(db, user, plan, form, now, create, read) {
  let row = await held(db, user);
  if (row && row.session && (row.state === "open" || row.state === "creating")) {
    const session = await read(row.session);
    if (!session || session.id !== row.session) throw new HttpError(502, "billing", "Could not confirm the existing checkout. Try again later.");
    if (session.status === "open") {
      if (row.plan !== plan) throw busy();
      if (!session.url) throw new HttpError(502, "billing", "Checkout is temporarily unavailable.");
      return { url: session.url };
    }
    if (session.status !== "expired") throw busy(); // complete can be awaiting its payment webhook
    await db.prepare("UPDATE student_checkouts SET state = 'expired' WHERE user_hash = ? AND attempt = ? AND state IN ('creating', 'open')")
      .bind(user, row.attempt).run();
    row = await held(db, user);
  }
  if (!row || row.state === "expired" || row.state === "completed") {
    const attempt = crypto.randomUUID();
    // The conditional upsert is the cross-request lock. Checking a row then inserting is not atomic.
    await db.prepare(
      "INSERT INTO student_checkouts (user_hash, attempt, plan, form, state, created) " +
      "SELECT ?, ?, ?, ?, 'creating', ? WHERE NOT EXISTS (SELECT 1 FROM plans WHERE user_hash = ? AND subscription IS NOT NULL AND status NOT IN ('canceled', 'incomplete_expired')) " +
      "AND NOT EXISTS (SELECT 1 FROM student_billing_recovery WHERE user_hash = ? AND state != 'resolved') " +
      "ON CONFLICT(user_hash) DO UPDATE SET attempt = excluded.attempt, plan = excluded.plan, form = excluded.form, state = 'creating', created = excluded.created, session = NULL " +
      "WHERE student_checkouts.state IN ('expired', 'completed')"
    ).bind(user, attempt, plan, JSON.stringify(form), now.toISOString(), user, user).run();
    row = await held(db, user);
  }
  if (!row || row.state !== "creating" || row.plan !== plan) throw busy();
  // Stripe may prune a key after 24 hours. Never reuse an uncertain creation beyond that boundary.
  if (now.getTime() - Date.parse(row.created) >= 23 * 60 * 60_000) {
    throw new HttpError(409, "billing_reconciliation", "Your earlier checkout needs confirmation. Please contact support before starting another.");
  }
  const session = await create(JSON.parse(row.form), "student-checkout:" + row.attempt);
  if (!session || !session.id || !session.url) throw new HttpError(502, "billing", "Checkout is temporarily unavailable. Try again later.");
  await db.prepare("UPDATE student_checkouts SET session = ?, state = 'open' WHERE user_hash = ? AND attempt = ? AND state = 'creating'")
    .bind(session.id, user, row.attempt).run();
  return { url: session.url };
}

export const completeStudentCheckout = (db, user, session) => db.prepare(
  "UPDATE student_checkouts SET state = 'completed', session = COALESCE(session, ?) WHERE user_hash = ? AND (session = ? OR session IS NULL)"
).bind(session || null, user, session || null);
