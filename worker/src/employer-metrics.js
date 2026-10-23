// 2026-10-23: was: leads and paid orders had no aggregate funnel report. Keep browser intent
// separate from server-confirmed money; never return contacts or identifiers. Revert: remove route.
import { HttpError } from "./http.js";

export async function employerMetrics(db, days, now) {
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new HttpError(400, "days", "days must be an integer from 1 to 90");
  }
  // Completed UTC days only, so comparing successive reports never compares a partial day.
  const end = now.toISOString().slice(0, 10);
  const start = new Date(Date.parse(end + "T00:00:00Z") - days * 86400e3).toISOString().slice(0, 10);
  const { results: events } = await db.prepare("SELECT day, event, page, SUM(n) AS n FROM event_counts " +
    "WHERE day >= ? AND day < ? AND event LIKE 'employer_%' GROUP BY day, event, page ORDER BY day, event, page")
    .bind(start, end).all();
  const { results: views } = await db.prepare("SELECT page, SUM(views) AS views FROM visit_counts " +
    "WHERE day >= ? AND day < ? AND page IN ('employers', 'employer_buy') GROUP BY page")
    .bind(start, end).all();
  const cash = await db.prepare("SELECT COUNT(*) AS orders, COALESCE(SUM(paid_amount), 0) AS collected_cents, " +
    "COALESCE(SUM(refunded_amount + COALESCE((SELECT SUM(c.amount) FROM employer_credits c " +
      "WHERE c.order_id = o.id AND c.status = 'refund' AND c.refund_id IS NOT NULL), 0)), 0) AS refunded_cents, " +
    "COALESCE(SUM(COALESCE((SELECT SUM(c.amount) FROM employer_credits c WHERE c.order_id = o.id " +
      "AND c.status = 'credit'), 0)), 0) AS issued_credit_cents, " +
    "COALESCE(SUM(COALESCE((SELECT SUM(c.amount) FROM employer_credits c WHERE c.order_id = o.id " +
      "AND c.status = 'offered'), 0)), 0) AS pending_compensation_cents, " +
    "COALESCE(SUM(CASE WHEN disputed_at IS NOT NULL THEN paid_amount ELSE 0 END), 0) AS disputed_original_cents " +
    "FROM employer_orders o WHERE paid_at >= ? AND paid_at < ? AND paid_amount > 0")
    .bind(start, end).first();
  const reports = await db.prepare("SELECT " +
    "SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) AS queued, " +
    "SUM(CASE WHEN state = 'sent' THEN 1 ELSE 0 END) AS sent, " +
    "SUM(CASE WHEN state = 'skipped' THEN 1 ELSE 0 END) AS skipped FROM employer_campaign_reports").first();
  return { start, end_exclusive: end, days, currency: "USD", events, page_views: views,
    cash_cohort: { ...cash, collected_less_recorded_refunds_cents: cash.collected_cents - cash.refunded_cents },
    campaign_reports_all_time: Object.fromEntries(Object.entries(reports).map(([k, v]) => [k, v || 0])),
    about: "Anonymous counts of actions, not unique people or a matched-person conversion funnel. Browser steps are intent, not payment. " +
      "Order-created counts include valid attempts whose confirmation email later failed. Paid events require a positive payment; pilots and zero-dollar checkouts are separate. " +
      "Repeat paid means a prior positive payment for the same employer key, not a renewed role. New event history starts at deployment; no historical backfill. " +
      "Cash is the cohort paid in this UTC window, with refunds recorded to date; it is not refund activity in this window, Stripe balance, revenue recognition or profit. " +
      "Subtract provider fees, disputed losses, credits still owed, hosting and staff time separately. Campaign report queue totals cover all time." };
}
