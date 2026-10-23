// 2026-10-23: transactional campaign results survive outages without treating anonymous counts as
// applications or unique people. was: only a manually requested calendar-month report.
// Revert: remove processCampaignReports from cron; keep its tombstones to prevent repeat messages.
import { mailOn, trySend } from "./mail.js";
import { roundedCount } from "./placements.js";

// 2026-10-23: a dedicated invocation must fit D1 Free's 50-query budget, including all eligibility
// checks and retry writes. was: 100 new + 100 due, sharing the heavy daily maintenance invocation.
// Revert: pause reports rather than increasing this cap without a measured per-invocation budget.
export const CAMPAIGN_REPORT_BATCH = 3;
export const CAMPAIGN_REPORT_CRON = "47 7 * * *";
export const CAMPAIGN_REPORT_ATTEMPTS = 8;
export const CAMPAIGN_REPORT_QUEUE_DAYS = 30;
const DAY_MS = 86400_000;
const LEASE_MS = 5 * 60_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const oneLine = (s) => String(s || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
const email = (s) => typeof s === "string" && s.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(s);
const dayOf = (now) => now.toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
const validDay = (day) => typeof day === "string" && DAY.test(day) && Number.isFinite(Date.parse(day + "T00:00:00Z"))
  && new Date(day + "T00:00:00Z").toISOString().slice(0, 10) === day;
const reportWindow = (row) => {
  const first = row.start_day.slice(0, 7), last = addDays(row.end_day, -1).slice(0, 7);
  const next = new Date(last + "-01T00:00:00Z");
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { first, last, start: first + "-01", end: dayOf(next) };
};

const CANDIDATE = "SELECT p.id AS placement_id, p.status AS placement_status, p.ended_reason, p.start_day, p.end_day, " +
  "p.listing_id, r.order_id, r.title, r.company, r.employer_key, o.status AS order_status, o.disputed_at, o.email " +
  "FROM placements p JOIN employer_order_roles r ON r.placement_id = p.id AND r.listing_id = p.listing_id " +
  "JOIN employer_orders o ON o.id = r.order_id ";

async function candidate(db, placementId) {
  return db.prepare(CANDIDATE + "WHERE p.id = ?").bind(placementId).first();
}

async function eligibility(db, row, now) {
  if (!row || row.order_status !== "approved" || row.disputed_at) return "order_ineligible";
  if (row.placement_status !== "ended" || row.ended_reason !== "dates" || !validDay(row.start_day) ||
      !validDay(row.end_day) || row.end_day > dayOf(now)) return "not_naturally_complete";
  const days = (Date.parse(row.end_day) - Date.parse(row.start_day)) / DAY_MS;
  if (!Number.isInteger(days) || days < 1 || days > 62) return "invalid_window";
  if (!email(row.email)) return "contact_unavailable";
  // A manual pause may have changed delivery. Conservatively omit such campaigns, even if later
  // resumed. A manual end that happens to use reason "dates" is not an automatic completed run.
  // Revert: remove these history gates only with a separately specified interrupted-campaign report.
  const stopped = await db.prepare("SELECT 1 AS found FROM placement_log WHERE placement = ? " +
    "AND action IN ('pause', 'end', 'refuse') LIMIT 1").bind(row.placement_id).first();
  if (stopped) return "interrupted";
  const ended = await db.prepare("SELECT before, after FROM placement_log WHERE placement = ? " +
    "AND action = 'cron_end' AND reason = 'dates' AND by = 'cron' ORDER BY at DESC, id DESC LIMIT 1")
    .bind(row.placement_id).first();
  try {
    const before = JSON.parse(ended?.before || "null"), after = JSON.parse(ended?.after || "null");
    if (before?.status !== "on" || after?.status !== "ended" || after?.ended_reason !== "dates" ||
        before.start_day !== row.start_day || before.end_day !== row.end_day ||
        after.start_day !== row.start_day || after.end_day !== row.end_day) return "completion_unverified";
  } catch { return "completion_unverified"; }
  return null;
}

async function totals(db, row, now) {
  // 2026-10-23: preserve placementReport's whole-ended-month privacy rule. was: campaign-day totals.
  // The existing atomic rollup moves old daily rows into monthly rows, deleting those daily rows;
  // both granularities can therefore be added for WHOLE months, including the 400-day boundary.
  // Revert: disable automatic reports; never substitute a custom range or an unfinished month.
  const window = reportWindow(row);
  if (window.last >= dayOf(now).slice(0, 7)) return { skip: "report_month_open" };
  const { results } = await db.prepare("SELECT day, page, event, CAST(n AS REAL) AS n FROM placement_counts WHERE placement = ? AND " +
    "((length(day) = 10 AND day >= ? AND day < ?) OR (length(day) = 7 AND day >= ? AND day <= ?))")
    .bind(row.placement_id, window.start, window.end, window.first, window.last).all();
  let shown = 0, opened = 0;
  for (const r of results) {
    if ((!MONTH.test(r.day) && !validDay(r.day)) || !["dashboard", "landing"].includes(r.page) || !["shown", "open"].includes(r.event) ||
        !Number.isSafeInteger(r.n) || r.n < 0) return { skip: "counts_invalid" };
    if (r.event === "shown") shown += r.n;
    else opened += r.n;
    if (!Number.isSafeInteger(shown) || !Number.isSafeInteger(opened)) return { skip: "counts_invalid" };
  }
  return { shown: roundedCount(shown), opened: roundedCount(opened) };
}

export function campaignReportMail(row, counts, env, now) {
  // Public keys are exact data keys, not slugs; URL encoding preserves spaces and ampersands.
  const company = typeof row.employer_key === "string" && row.employer_key.trim() && row.employer_key.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(row.employer_key)
    ? "?company=" + encodeURIComponent(row.employer_key) : "";
  const window = reportWindow(row);
  return {
    to: row.email,
    subject: "Your InternScout listing results",
    text: `Your paid listing campaign window has ended.\n\nRole: ${oneLine(row.title)}\nEmployer: ${oneLine(row.company)}\n` +
      `Campaign window (UTC): ${row.start_day} through ${addDays(row.end_day, -1)}, inclusive. ` +
      `The end boundary is ${row.end_day} at 00:00 UTC and is not included.\n\n` +
      `Report period (UTC): ${window.start} through ${addDays(window.end, -1)}, inclusive, covering whole calendar months.\n` +
      `Report generated: ${now.toISOString()}. Counts are a snapshot recorded at generation.\n\n` +
      `Recorded listing-box shows: ${counts.shown}\nRecorded posting-link opens: ${counts.opened}\n\n` +
      "Reports wait until every calendar month containing the campaign has ended. These are aggregate event " +
      "counts recorded on InternScout during the full report period above, including days outside the campaign " +
      "window if any were recorded, rounded down to " +
      "the nearest 10; anything under 10 reads \"fewer than 10\". They can include repeat events by the same " +
      "person and automated traffic our filters missed. They are estimates, not audited figures or unique " +
      "people. InternScout does not see applications and cannot say how many people applied. The dates " +
      "describe the campaign window, not a guarantee that the box was served every day. Payment did not " +
      "change search ranking or scores.\n\n" +
      `If you want to review options for another listing: https://internscout.org/employers/buy/${company}\n` +
      "Nothing renews automatically. You can reply to this email with questions.",
    ...(email(env.REVIEW_TO) ? { replyTo: env.REVIEW_TO } : {}),
  };
}

async function skip(db, placementId, reason, now, leaseToken = null) {
  return db.prepare("UPDATE employer_campaign_reports SET state = 'skipped', skipped_reason = ?, terminal_at = ?, " +
    "sending_until = NULL, lease_token = NULL, next_attempt_at = NULL, to_address = NULL, subject = NULL, body = NULL, reply_to = NULL " +
    "WHERE placement_id = ? AND state = 'queued'" + (leaseToken ? " AND lease_token = ?" : ""))
    .bind(reason, now.toISOString(), placementId, ...(leaseToken ? [leaseToken] : [])).run();
}

export async function expireCampaignReportMail(db, now) {
  const cutoff = new Date(now.getTime() - CAMPAIGN_REPORT_QUEUE_DAYS * DAY_MS).toISOString();
  const result = await db.prepare("UPDATE employer_campaign_reports SET state = 'skipped', " +
    "skipped_reason = CASE WHEN created <= ? THEN 'queue_expired' ELSE 'delivery_attempts_exhausted' END, " +
    "terminal_at = ?, sending_until = NULL, lease_token = NULL, next_attempt_at = NULL, to_address = NULL, " +
    "subject = NULL, body = NULL, reply_to = NULL WHERE state = 'queued' AND (created <= ? OR " +
    "(attempts >= ? AND (sending_until IS NULL OR sending_until <= ?)))")
    .bind(cutoff, now.toISOString(), cutoff, CAMPAIGN_REPORT_ATTEMPTS, now.toISOString()).run();
  return result.meta.changes;
}

async function enqueue(db, env, row, now) {
  let reason = await eligibility(db, row, now);
  const counts = reason ? null : await totals(db, row, now);
  if (counts?.skip === "report_month_open") return null; // Wait for closure; do not create a permanent skipped tombstone.
  reason ||= counts?.skip;
  const mail = reason ? null : campaignReportMail(row, counts, env, now);
  const at = now.toISOString();
  // The condition is read again in the insert so a concurrent dispute/status/date edit does not queue
  // stale contact data. INSERT OR IGNORE provides one durable queue/tombstone per placement.
  const inserted = await db.prepare("INSERT OR IGNORE INTO employer_campaign_reports " +
    "(placement_id, order_id, start_day, end_day, created, state, skipped_reason, terminal_at, next_attempt_at, " +
    "to_address, subject, body, reply_to) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (" +
    "SELECT 1 FROM employer_orders o JOIN employer_order_roles r ON r.order_id = o.id JOIN placements p ON p.id = r.placement_id " +
    "WHERE o.id = ? AND p.id = ? AND o.status = 'approved' AND o.disputed_at IS NULL AND p.status = 'ended' " +
    "AND p.ended_reason = 'dates' AND p.start_day = ? AND p.end_day = ? AND o.email = ?)")
    .bind(row.placement_id, row.order_id, row.start_day, row.end_day, at, reason ? "skipped" : "queued", reason || null,
      reason ? at : null, reason ? null : at, mail?.to || null, mail?.subject || null, mail?.text || null, mail?.replyTo || null,
      row.order_id, row.placement_id, row.start_day, row.end_day, row.email).run();
  return inserted.meta.changes ? (reason ? "skipped" : "queued") : null;
}

async function deliver(db, env, placementId, now) {
  if (!mailOn(env)) return { attempted: 0, sent: 0, skipped: 0 };
  const at = now.toISOString(), token = crypto.randomUUID();
  const claim = await db.prepare("UPDATE employer_campaign_reports SET sending_until = ?, lease_token = ?, attempted_at = ?, " +
    "attempts = attempts + 1 WHERE placement_id = ? AND state = 'queued' AND attempts < ? " +
    "AND next_attempt_at <= ? AND (sending_until IS NULL OR sending_until <= ?)")
    .bind(new Date(now.getTime() + LEASE_MS).toISOString(), token, at, placementId, CAMPAIGN_REPORT_ATTEMPTS, at, at).run();
  if (!claim.meta.changes) return { attempted: 0, sent: 0, skipped: 0 };
  const queued = await db.prepare("SELECT * FROM employer_campaign_reports WHERE placement_id = ? AND lease_token = ?")
    .bind(placementId, token).first();
  if (!queued) return { attempted: 1, sent: 0, skipped: 0 };
  const current = await candidate(db, placementId);
  const reason = await eligibility(db, current, now);
  if (reason || current.order_id !== queued.order_id || current.start_day !== queued.start_day ||
      current.end_day !== queued.end_day || current.email !== queued.to_address) {
    await skip(db, placementId, reason || "campaign_changed", now, token);
    return { attempted: 1, sent: 0, skipped: 1 };
  }
  const sent = await trySend(env, { to: queued.to_address, subject: queued.subject, text: queued.body,
    ...(queued.reply_to ? { replyTo: queued.reply_to } : {}) }, "campaign results");
  if (sent) {
    await db.prepare("UPDATE employer_campaign_reports SET state = 'sent', sent_at = ?, terminal_at = ?, " +
      "sending_until = NULL, lease_token = NULL, next_attempt_at = NULL, to_address = NULL, subject = NULL, body = NULL, reply_to = NULL " +
      "WHERE placement_id = ? AND state = 'queued' AND lease_token = ?").bind(at, at, placementId, token).run();
  } else if (queued.attempts >= CAMPAIGN_REPORT_ATTEMPTS) {
    await skip(db, placementId, "delivery_attempts_exhausted", now, token);
  } else {
    const delay = Math.min(DAY_MS, 15 * 60_000 * 2 ** (queued.attempts - 1));
    await db.prepare("UPDATE employer_campaign_reports SET sending_until = NULL, lease_token = NULL, next_attempt_at = ? " +
      "WHERE placement_id = ? AND state = 'queued' AND lease_token = ?")
      .bind(new Date(now.getTime() + delay).toISOString(), placementId, token).run();
  }
  // As with the existing order outbox, a crash after provider acceptance but before the sent marker
  // can cause a duplicate. The lease/retry design does not claim exactly-once email delivery.
  return { attempted: 1, sent: sent ? 1 : 0, skipped: !sent && queued.attempts >= CAMPAIGN_REPORT_ATTEMPTS ? 1 : 0 };
}

export async function processCampaignReports(db, env, now) {
  const expired = await expireCampaignReportMail(db, now);
  const { results: candidates } = await db.prepare(CANDIDATE +
    "WHERE o.status = 'approved' AND o.disputed_at IS NULL AND p.status = 'ended' AND p.ended_reason = 'dates' " +
    "AND p.end_day <= ? AND substr(date(p.end_day, '-1 day'), 1, 7) < ? " +
    "AND NOT EXISTS (SELECT 1 FROM employer_campaign_reports c WHERE c.placement_id = p.id) " +
    "ORDER BY p.end_day DESC, p.id LIMIT ?").bind(dayOf(now), dayOf(now).slice(0, 7), CAMPAIGN_REPORT_BATCH).all();
  const result = { queued: 0, attempted: 0, sent: 0, skipped: expired };
  for (const row of candidates) {
    const state = await enqueue(db, env, row, now);
    if (state) result[state]++;
  }
  const { results: due } = await db.prepare("SELECT placement_id FROM employer_campaign_reports WHERE state = 'queued' " +
    "AND next_attempt_at <= ? AND (sending_until IS NULL OR sending_until <= ?) ORDER BY created, placement_id LIMIT ?")
    .bind(now.toISOString(), now.toISOString(), CAMPAIGN_REPORT_BATCH).all();
  for (const row of due) {
    const delivered = await deliver(db, env, row.placement_id, now);
    result.attempted += delivered.attempted;
    result.sent += delivered.sent;
    result.skipped += delivered.skipped;
  }
  return result;
}
