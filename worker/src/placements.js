// Paid listings ("placements", added 2026-10-14). The record of which listing an employer paid to show
// in a separate, labelled box, and on which days. The rule this file serves: payment never changes any
// score, order, filter, count or Auto-Apply behaviour. So nothing here touches a listing. A placement
// only names a listing by the id the pipeline already gave it (backend normalize.listing_id), and the
// site build (not a visitor) reads the public GET /placements once per deploy.
//
// The code says "placement" everywhere, never "paid": in the dashboard "paid" already means "the role
// pays" (the pay filter).
//
// Two kinds of route:
// - GET /placements, public: the placements that are on today, without any private field.
// - /admin/..., for Bruce's own terminal only (scripts/placement.mjs): hidden (404) until the
//   ADMIN_TOKEN secret is set, refused (403) for any request carrying an Origin header, because that
//   is a browser, and 401 without the right Bearer token. ADMIN_TOKEN is its own secret, not
//   DEMAND_TOKEN, because DEMAND_TOKEN is also stored in GitHub's CI secrets.
//
// There is no payment code. Bruce invoices from his own Stripe dashboard and records "pilot" or the
// invoice number as `paid_ref` when he switches a placement on. Contract: API.md "Placements".
import { HttpError, sameSecret } from "./http.js";

// Most days one placement may run. Longer deals are two placements.
export const MAX_DAYS = 62;
// Paid boxes per page. The table's CHECK holds page_cap at 1 too.
export const PAGE_CAP = 1;
// The sponsor checks (B1-market-policy.md section 6 item 11). Bruce does each by hand; all are needed
// before a placement can be `checked`, and only a checked (or paused) placement can be switched on.
export const CHECKS = [
  "role_on_employer_site",     // the role is open on the employer's own careers site
  "email_domain",              // the contact writes from the company's domain
  "pay_range_where_required",  // a pay range is posted where the role's state requires one
  "paid_or_public_body",       // the role is paid, or the employer is a nonprofit or government body (then unpaid_ok)
  "min_age_if_hs",             // a minimum age is stated if the role is open to high school students
  "not_hazardous_for_minors",  // nothing on the DOL hazardous list for under-18s
  "no_fee_no_early_data",      // no fee, and no personal details asked before the posting is shown
  "no_targeting_asked",        // the employer accepted: no targeting by school, major, age or any protected trait
];
// Why a placement ended. "dates" is what the daily cron writes.
export const END_REASONS = ["dates", "role_closed", "listing_gone", "removed", "refunded"];
export const MAX_ADMIN_BYTES = 4_000;
// How many recent leads GET /admin/leads lists, and log entries per placement GET /admin/placements shows.
const LEADS_SHOWN = 100;
const LOG_SHOWN = 20;

const LISTING_ID = /^[0-9a-f]{16}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// A short label for who made a change ("bruce"). Letters, digits, - and _ only, so it can never be an email.
const BY = /^[A-Za-z0-9_-]{1,32}$/;
const CONTROL = /[\u0000-\u001F\u007F]/g;
const LIMITS = { employer: 120, apply_url: 2000, note: 500, paid_ref: 64, reason: 200 };

// The fields GET /placements returns, and nothing else. Never paid_ref, note, lead_id, checks or *_by.
// unpaid_ok is public because the site build keeps an unpaid role only when it is set (placements.py).
export const PUBLIC_KEYS = ["id", "listing_id", "apply_url", "employer", "start", "end", "page_cap", "unpaid_ok"];

const bad = (field, message) => new HttpError(400, "bad_request", message, { field });
const conflict = (message) => new HttpError(409, "conflict", message);

// Admin auth. Same pattern as GET /demand (index.js), plus the 404 while unset and the Origin refusal.
export async function requireAdmin(request, env) {
  // Hidden until the secret is set, like the billing routes while payments are off.
  if (!env.ADMIN_TOKEN) throw new HttpError(404, "not_found", "No such endpoint");
  // Called from Bruce's terminal, never from a page: a request with an Origin header is a browser.
  if (request.headers.get("Origin")) throw new HttpError(403, "forbidden", "Not from a browser");
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || !(await sameSecret(token, env.ADMIN_TOKEN))) throw new HttpError(401, "auth", "Admin token required");
}

export const dayOf = (now) => now.toISOString().slice(0, 10);
// addDays and daysBetween are exported (2026-10-19) for the paid listing orders (orders.js).
// was: const addDays = ...; const daysBetween = ...
export const addDays = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * 86400e3).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400e3);

// One text field: a string (or absent), control characters gone, trimmed, inside its limit.
function text(body, field, { required = false } = {}) {
  const v = body[field];
  if (v != null && typeof v !== "string") throw bad(field, `${field} must be text`);
  const s = (v || "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (required && !s) throw bad(field, `${field} is required`);
  if (s.length > LIMITS[field]) throw bad(field, `${field} is too long (at most ${LIMITS[field]} characters)`);
  return s;
}

function by(body) {
  if (typeof body.by !== "string" || !BY.test(body.by)) {
    throw bad("by", "by must be a short label such as \"bruce\" (letters, digits, - or _)");
  }
  return body.by;
}

function day(body, field) {
  const v = body[field];
  if (typeof v !== "string" || !DAY.test(v) || Number.isNaN(Date.parse(v + "T00:00:00Z"))
      || new Date(v + "T00:00:00Z").toISOString().slice(0, 10) !== v) {
    throw bad(field, `${field} must be a day as YYYY-MM-DD`);
  }
  return v;
}

function listingId(body) {
  const v = body.listing_id;
  if (typeof v !== "string" || !LISTING_ID.test(v)) throw bad("listing_id", "listing_id must be 16 lowercase hex characters");
  return v;
}

function applyUrl(body) {
  const v = text(body, "apply_url", { required: true });
  let u;
  try {
    u = new URL(v);
  } catch {
    throw bad("apply_url", "apply_url must be a full https:// address");
  }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) {
    throw bad("apply_url", "apply_url must be a full https:// address");
  }
  return v;
}

function checkDates(start, end) {
  if (end <= start) throw bad("end", "end must be after start (end is the first day it no longer shows)");
  if (daysBetween(start, end) > MAX_DAYS) throw bad("end", `A placement runs at most ${MAX_DAYS} days`);
}

function placementId(body) {
  if (typeof body.id !== "string" || !/^p-[a-z0-9-]{1,80}$/.test(body.id)) throw bad("id", "id must be a placement id such as p-2026-11-acme-1");
  return body.id;
}

const slug = (s) => s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "") || "employer";

async function load(db, id) {
  const row = await db.prepare("SELECT * FROM placements WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, "not_found", "No such placement");
  return row;
}

// The two writes every change makes, in one batch: the row, then its log entry. The update only lands
// if nobody changed the row since it was read (same status and `updated`), and the log entry only if
// the update landed, so a lost race leaves no stray log row. `updated` always moves forward by at least
// a millisecond, which is what makes the second condition exact.
async function save(db, before, changes, action, who, reason, now) {
  let updated = now.toISOString();
  if (updated <= before.updated) updated = new Date(Date.parse(before.updated) + 1).toISOString();
  const after = { ...before, ...changes, updated, updated_by: who };
  const cols = ["employer", "listing_id", "apply_url", "start_day", "end_day", "status", "checks", "checked_day",
    "unpaid_ok", "paid_ref", "note", "ended_reason", "updated", "updated_by"];
  const [res] = await db.batch([
    db.prepare(`UPDATE placements SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND status = ? AND updated = ?`)
      .bind(...cols.map((c) => after[c]), before.id, before.status, before.updated),
    db.prepare("INSERT INTO placement_log (placement, at, by, action, reason, before, after) " +
      "SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM placements WHERE id = ? AND updated = ? AND updated_by = ?)")
      .bind(before.id, updated, who, action, reason || "", JSON.stringify(before), JSON.stringify(after), before.id, updated, who),
  ]);
  if (!res.meta.changes) throw conflict("The placement changed while this was being saved. Read it again and retry.");
  return after;
}

// GET /placements (public): what the site build turns into /data/placements.json. Only placements that
// are on and inside their dates; `start_day <= tomorrow` lets a build late in the evening (UTC) carry a
// placement that starts at midnight, and the dashboard and landing pages check the dates themselves.
export async function livePlacements(db, now) {
  const today = dayOf(now);
  const { results } = await db.prepare(
    "SELECT id, listing_id, apply_url, employer, start_day, end_day, page_cap, unpaid_ok FROM placements " +
    "WHERE status = 'on' AND end_day > ? AND start_day <= ? ORDER BY start_day, id",
  ).bind(today, addDays(today, 1)).all();
  return {
    day: today,
    placements: results.map((r) => ({
      id: r.id, listing_id: r.listing_id, apply_url: r.apply_url, employer: r.employer,
      start: r.start_day, end: r.end_day, page_cap: Math.min(r.page_cap, PAGE_CAP), unpaid_ok: r.unpaid_ok ? 1 : 0,
    })),
  };
}

// GET /admin/placements: every row, private fields included, with its last LOG_SHOWN log entries.
export async function listPlacements(db) {
  const rows = (await db.prepare("SELECT * FROM placements ORDER BY start_day DESC, id").all()).results;
  const log = (await db.prepare(
    "SELECT placement, at, by, action, reason, before, after FROM (SELECT *, ROW_NUMBER() OVER " +
    "(PARTITION BY placement ORDER BY at DESC, id DESC) AS n FROM placement_log) WHERE n <= ? ORDER BY at DESC, id DESC",
  ).bind(LOG_SHOWN).all()).results;
  const runs = await placementRuns(db);   // 2026-10-14: the build's record, at the end of this file
  return {
    placements: rows.map((r) => ({
      ...r,
      log: log.filter((e) => e.placement === r.id).map(({ placement, before, after, ...e }) =>
        ({ ...e, before: before && JSON.parse(before), after: after && JSON.parse(after) })),
      runs: runs[r.id] || { days_shown: 0, days_dropped: 0, drops: [] },
    })),
  };
}

// GET /admin/leads: the starting point for a placement, without the recruiter's name, email or message.
// Contact details stay behind `wrangler d1 execute`, as leads.js says.
export async function listLeads(db) {
  const { results } = await db.prepare(
    "SELECT id, created, company, wants FROM employer_leads ORDER BY created DESC, id DESC LIMIT ?",
  ).bind(LEADS_SHOWN).all();
  return { leads: results };
}

// POST /admin/placements: a new draft.
export async function createPlacement(db, body, now) {
  const who = by(body);
  const listing = listingId(body);
  const url = applyUrl(body);
  const start = day(body, "start");
  const end = day(body, "end");
  checkDates(start, end);
  const note = text(body, "note");
  let employer = text(body, "employer");
  let lead = null;
  if (body.lead_id != null) {
    if (!Number.isSafeInteger(body.lead_id) || body.lead_id < 1) throw bad("lead_id", "lead_id must be a lead's id number");
    // Only the company is read. The lead's name and email never reach a placement.
    const row = await db.prepare("SELECT id, company FROM employer_leads WHERE id = ?").bind(body.lead_id).first();
    if (!row) throw new HttpError(404, "not_found", "No such lead", { field: "lead_id" });
    lead = row.id;
    employer ||= String(row.company).slice(0, LIMITS.employer);
  }
  if (!employer) throw bad("employer", "employer is required when there is no lead_id");

  const prefix = `p-${start.slice(0, 7)}-${slug(employer)}-`;
  const taken = await db.prepare("SELECT COUNT(*) AS n FROM placements WHERE id LIKE ?").bind(prefix + "%").first("n");
  const at = now.toISOString();
  const row = {
    id: prefix + (Number(taken) + 1), lead_id: lead, employer, listing_id: listing, apply_url: url,
    start_day: start, end_day: end, page_cap: PAGE_CAP, status: "draft", checks: "", checked_day: null,
    unpaid_ok: 0, paid_ref: "", note, ended_reason: "", created: at, created_by: who, updated: at, updated_by: who,
  };
  const cols = Object.keys(row);
  try {
    await db.batch([
      db.prepare(`INSERT INTO placements (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...cols.map((c) => row[c])),
      db.prepare("INSERT INTO placement_log (placement, at, by, action, reason, before, after) VALUES (?, ?, ?, 'create', '', NULL, ?)")
        .bind(row.id, at, who, JSON.stringify(row)),
    ]);
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e && e.message))) throw conflict("That placement id was just taken. Try again.");
    throw e;
  }
  return row;
}

// POST /admin/placements/update. Before a placement is on: dates, apply URL, listing id, employer and
// note. Moving it to another listing or URL clears the checks and sends it back to draft, because they
// were done for the old one. While it is on: only a later `end` (an extension) and the note, so a live
// placement cannot be moved to another listing without being paused first.
export async function updatePlacement(db, body, now) {
  const who = by(body);
  const row = await load(db, placementId(body));
  const has = (k) => Object.hasOwn(body, k);
  const allowed = row.status === "on" ? ["end", "note"] : ["start", "end", "listing_id", "apply_url", "employer", "note"];
  if (!["draft", "checked", "paused", "on"].includes(row.status)) throw conflict(`A placement that is ${row.status} cannot be changed`);
  const known = ["id", "by", "start", "end", "listing_id", "apply_url", "employer", "note"];
  const unknown = Object.keys(body).filter((k) => !known.includes(k));
  if (unknown.length) throw bad(unknown[0], `${unknown[0]} cannot be changed here`);
  const refused = known.slice(2).filter((k) => has(k) && !allowed.includes(k));
  if (refused.length) throw conflict(`While it is on, only end (later) and note can change; pause it first to change ${refused[0]}`);

  const c = {};
  if (has("start")) c.start_day = day(body, "start");
  if (has("end")) c.end_day = day(body, "end");
  if (has("listing_id")) c.listing_id = listingId(body);
  if (has("apply_url")) c.apply_url = applyUrl(body);
  if (has("employer")) c.employer = text(body, "employer", { required: true });
  if (has("note")) c.note = text(body, "note");
  if (!Object.keys(c).length) throw bad(null, "Nothing to change");
  checkDates(c.start_day || row.start_day, c.end_day || row.end_day);
  if (row.status === "on" && c.end_day && c.end_day <= row.end_day) {
    throw conflict("While it is on, end can only move later. To stop it sooner, use end or pause.");
  }
  const moved = (c.listing_id && c.listing_id !== row.listing_id) || (c.apply_url && c.apply_url !== row.apply_url);
  if (moved) Object.assign(c, { status: "draft", checks: "", checked_day: null, unpaid_ok: 0 });
  return save(db, row, c, "update", who, "", now);
}

// POST /admin/placements/check: records the sponsor checks Bruce did. The placement becomes `checked`
// only when every one in CHECKS is there; otherwise it stays (or goes back to) draft.
export async function checkPlacement(db, body, now) {
  const who = by(body);
  const row = await load(db, placementId(body));
  if (!["draft", "checked"].includes(row.status)) throw conflict(`A placement that is ${row.status} cannot be checked again`);
  if (!Array.isArray(body.checks) || body.checks.some((k) => typeof k !== "string")) throw bad("checks", "checks must be a list");
  const unknown = body.checks.find((k) => !CHECKS.includes(k));
  if (unknown) throw bad("checks", `Unknown check: ${unknown}. The checks are: ${CHECKS.join(", ")}`);
  if (body.unpaid_ok != null && typeof body.unpaid_ok !== "boolean") throw bad("unpaid_ok", "unpaid_ok must be true or false");
  const done = CHECKS.filter((k) => body.checks.includes(k));
  return save(db, row, {
    checks: done.join(","),
    checked_day: dayOf(now),
    unpaid_ok: body.unpaid_ok ? 1 : 0,
    status: done.length === CHECKS.length ? "checked" : "draft",
  }, "check", who, "", now);
}

// POST /admin/placements/on: only from checked or paused, and only with paid_ref ("pilot" or the
// invoice number). This is where Bruce's own statement "payment cleared, or this is a pilot" is kept.
export async function switchOn(db, body, now) {
  const who = by(body);
  const row = await load(db, placementId(body));
  if (!["checked", "paused"].includes(row.status)) throw conflict(`Only a checked or paused placement can be switched on (this one is ${row.status})`);
  const ref = text(body, "paid_ref", { required: true });
  if (row.checks.split(",").filter(Boolean).length !== CHECKS.length) throw conflict("Every sponsor check has to be done first");
  if (row.end_day <= dayOf(now)) throw conflict("Its end day has passed. Move end later first.");
  return save(db, row, { status: "on", paid_ref: ref }, "on", who, "", now);
}

export async function pausePlacement(db, body, now) {
  const who = by(body);
  const row = await load(db, placementId(body));
  const reason = text(body, "reason", { required: true });
  if (row.status !== "on") throw conflict(`Only a placement that is on can be paused (this one is ${row.status})`);
  return save(db, row, { status: "paused" }, "pause", who, reason, now);
}

// POST /admin/placements/end: the emergency stop, from any status that has not already finished.
export async function endPlacement(db, body, now) {
  const who = by(body);
  const row = await load(db, placementId(body));
  if (!END_REASONS.includes(body.reason)) throw bad("reason", `reason must be one of ${END_REASONS.join(", ")}`);
  if (["ended", "refused"].includes(row.status)) throw conflict(`This placement is already ${row.status}`);
  return save(db, row, { status: "ended", ended_reason: body.reason }, "end", who, body.reason, now);
}

export async function refusePlacement(db, body, now) {
  const who = by(body);
  const row = await load(db, placementId(body));
  const reason = text(body, "reason", { required: true });
  if (!["draft", "checked"].includes(row.status)) throw conflict(`Only a draft or checked placement can be refused (this one is ${row.status})`);
  return save(db, row, { status: "refused" }, "refuse", who, reason, now);
}

// Daily cron: a placement that is on or paused and whose end day has come ends, with reason "dates".
// ---------------------------------------------------------------- shown and opened counts (S9)
// The employer report (B1-data-privacy.md section 4.3 and 4.4). Whole calendar months that have ended,
// never a day, a custom range or the month still running, so two reports can't be subtracted to reveal a
// small number. Every count is rounded down to the nearest 10 and anything under REPORT_MIN reads "fewer
// than 10". The split by kind of page is given only when every one of its numbers is REPORT_MIN or more;
// otherwise the totals alone. There is no breakdown by anything about the audience, because nothing
// about the audience is counted. The counts can be forged (anyone can send /hit), so they are estimates
// and never the basis of a price.
export const REPORT_MIN = 10;
// Daily rows older than this are folded into one row per month (rollupPlacementCounts).
export const COUNT_DAYS = 400;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function roundedCount(n) {
  const v = Number(n) || 0;
  if (v < REPORT_MIN) return `fewer than ${REPORT_MIN}`;
  return `${(Math.floor(v / 10) * 10).toLocaleString("en-US")}+`;
}

// POST /admin/placements/report { id, month: "YYYY-MM" }: one placement's report for one ended month.
export async function placementReport(db, body, now) {
  const id = typeof body.id === "string" ? body.id : "";
  const row = id ? await db.prepare("SELECT id, employer, listing_id FROM placements WHERE id = ?").bind(id).first() : null;
  if (!row) throw new HttpError(404, "not_found", "No such placement");
  const month = body.month;
  if (typeof month !== "string" || !MONTH.test(month)) throw bad("month", "month must be YYYY-MM");
  if (month >= dayOf(now).slice(0, 7)) throw bad("month", "Reports cover whole months that have ended");
  const { results } = await db.prepare(
    "SELECT page, event, SUM(n) AS n FROM placement_counts WHERE placement = ? AND (day = ? OR day LIKE ?) GROUP BY page, event",
  ).bind(id, month, month + "-%").all();
  const get = (page, event) => results.filter((r) => (!page || r.page === page) && r.event === event).reduce((a, r) => a + r.n, 0);
  const pages = ["dashboard", "landing"].filter((p) => results.some((r) => r.page === p));
  const split = pages.length > 1 && pages.every((p) => get(p, "shown") >= REPORT_MIN && get(p, "open") >= REPORT_MIN);
  return {
    placement: row.id, employer: row.employer, listing_id: row.listing_id, month,
    shown: roundedCount(get(null, "shown")),
    opened: roundedCount(get(null, "open")),
    by_page: split ? Object.fromEntries(pages.map((p) => [p, { shown: roundedCount(get(p, "shown")), opened: roundedCount(get(p, "open")) }])) : null,
    about: "Daily totals InternScout counts on its own site, for the whole month (UTC), rounded down to the nearest 10; "
      + `anything under ${REPORT_MIN} reads "fewer than ${REPORT_MIN}". They say nothing about who saw or opened the listing, can include `
      + "repeat views by the same person and some automated traffic our filters missed, and are estimates, not audited figures. "
      + "InternScout does not see applications, so it cannot say how many people applied. Paying did not change where any "
      + "listing appears in search results or how it is scored.",
  };
}

// Daily cron: a placement's daily counts older than COUNT_DAYS become one row per month, then go.
export async function rollupPlacementCounts(db, now) {
  const cutoff = new Date(now.getTime() - COUNT_DAYS * 86400e3).toISOString().slice(0, 10);
  await db.batch([
    db.prepare(
      "INSERT INTO placement_counts (day, placement, page, event, n) " +
      "SELECT substr(day, 1, 7), placement, page, event, SUM(n) FROM placement_counts WHERE length(day) = 10 AND day < ? " +
      "GROUP BY substr(day, 1, 7), placement, page, event " +
      "ON CONFLICT(day, placement, page, event) DO UPDATE SET n = n + excluded.n",
    ).bind(cutoff),
    db.prepare("DELETE FROM placement_counts WHERE length(day) = 10 AND day < ?").bind(cutoff),
  ]);
}

export async function endExpiredPlacements(db, now) {
  const { results } = await db.prepare(
    "SELECT * FROM placements WHERE status IN ('on', 'paused') AND end_day <= ?",
  ).bind(dayOf(now)).all();
  for (const row of results) {
    try {
      await save(db, row, { status: "ended", ended_reason: "dates" }, "cron_end", "cron", "dates", now);
    } catch (e) {
      // A row changed by hand at the same moment is left for tomorrow's run.
      if (!(e instanceof HttpError)) throw e;
    }
  }
  return results.length;
}

// ---------------------------------------------------------------- the build's record (2026-10-14)
// `runs` in GET /admin/placements, by placement id, from placement_runs (worker/schema.sql), which the
// site build writes after each deploy's build (backend/internscout/placements.py record_runs). For
// working out refunds for days a paid box was not on the site:
//   days_shown    days on which at least one build kept the placement
//   days_dropped  days on which at least one build dropped it while it was live (dropped > 0)
//   drops         those days, oldest first, with the latest drop's reason (placements.py REASONS)
// One day can count in both when two builds that day disagreed.
export async function placementRuns(db) {
  const { results } = await db.prepare(
    "SELECT placement_id, day, shown, dropped, reason FROM placement_runs ORDER BY placement_id, day",
  ).all();
  const runs = {};
  for (const d of results) {
    const r = (runs[d.placement_id] ||= { days_shown: 0, days_dropped: 0, drops: [] });
    if (d.shown > 0) r.days_shown += 1;
    if (d.dropped > 0) {
      r.days_dropped += 1;
      r.drops.push({ day: d.day, reason: d.reason || "" });
    }
  }
  return runs;
}
