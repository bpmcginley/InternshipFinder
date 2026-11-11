import { addDays, dayOf } from "../placements.js";
import { readShard, shardOf } from "./roles.js";
import { CHECKOUT_HOLD_MS, DAYS, FIELD_CAP, LISTING_ID, MAX_START_DAYS, bad, conflict, fieldsOf } from "./shared.js";

// Placement statuses that hold days against the field cap.
const HOLDING = ["draft", "checked", "on", "paused"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------- the field cap

// A placement not made for an order (one Bruce made with scripts/placement.mjs).
const NOT_ORDERED = "p.id NOT IN (SELECT placement_id FROM employer_order_roles WHERE placement_id IS NOT NULL)";
const ALL_SHARDS = [..."abcdefghijklmnopqrstuvwxyz0123456789_"];

// A listing's field tags from the role index: the shard its employer's name points at first, then the
// rest. [] when the role isn't listed today; readShard throws when the index can't be read.
async function listingFields(env, listingId, employer, fetchImpl) {
  const first = shardOf(String(employer || "").toLowerCase());
  for (const s of [first, ...ALL_SHARDS.filter((x) => x !== first)]) {
    const r = (await readShard(env, s, fetchImpl)).get(listingId);
    if (r) return r.f;
  }
  return [];
}

// Records the fields of a placement made by hand, so it counts toward FIELD_CAP. Run after the admin
// create and update routes (index.js) and by the daily cron for any not done yet, moved to another
// listing, or not found last time. A placement made for an order is left alone: its role has its fields.
export async function notePlacementFields(db, env, id, fetchImpl, now) {
  const p = await db.prepare(`SELECT p.id, p.listing_id, p.employer FROM placements p WHERE p.id = ? AND ${NOT_ORDERED}`).bind(id).first();
  if (!p) return null;
  const fields = fieldsOf(await listingFields(env, p.listing_id, p.employer, fetchImpl));
  await db.prepare(
    "INSERT INTO placement_fields (placement_id, listing_id, fields, looked_up) VALUES (?, ?, ?, ?) ON CONFLICT(placement_id) " +
    "DO UPDATE SET listing_id = excluded.listing_id, fields = excluded.fields, looked_up = excluded.looked_up",
  ).bind(p.id, p.listing_id, fields.join(","), now.toISOString()).run();
  return fields;
}

async function fillPlacementFields(db, env, now, fetchImpl) {
  const { results } = await db.prepare(
    "SELECT p.id FROM placements p LEFT JOIN placement_fields f ON f.placement_id = p.id " +
    `WHERE p.status IN (${HOLDING.map(() => "?").join(", ")}) AND ${NOT_ORDERED} ` +
    "AND (f.placement_id IS NULL OR f.listing_id != p.listing_id OR f.fields = 'other')",
  ).bind(...HOLDING).all();
  for (const r of results) await notePlacementFields(db, env, r.id, fetchImpl, now);
}

// Every paid role that holds days, other than `exceptOrder`'s: { listing, fields, start, end } (end
// exclusive). Paid and approved orders hold the days of their placements while those are draft, checked,
// on or paused (or the order's own days if its placements are not made yet); a verified order holds its
// days for CHECKOUT_HOLD_MS after its Checkout opened.
async function heldRoles(db, now, exceptOrder = "") {
  const cutoff = new Date(now.getTime() - CHECKOUT_HOLD_MS).toISOString();
  const { results } = await db.prepare(
    "SELECT o.id AS order_id, o.checkout_at, r.listing_id, r.fields, o.status, o.start_day, p.status AS p_status, p.start_day AS p_start, p.end_day AS p_end " +
    "FROM employer_order_roles r JOIN employer_orders o ON o.id = r.order_id LEFT JOIN placements p ON p.id = r.placement_id " +
    "WHERE o.id != ? AND (o.status IN ('paid', 'approved') OR (o.status = 'verified' AND o.checkout_at > ?))",
  ).bind(exceptOrder, cutoff).all();
  const held = [];
  for (const r of results) {
    const fields = fieldsOf(String(r.fields || "").split(",").filter(Boolean));
    if (r.p_status) {
      if (HOLDING.includes(r.p_status)) held.push({ order: r.order_id, listing: r.listing_id, fields, start: r.p_start, end: r.p_end, expires: null });
    } else if (r.status !== "approved") {
      held.push({ order: r.order_id, listing: r.listing_id, fields, start: r.start_day, end: addDays(r.start_day, DAYS),
        expires: r.status === "verified" ? new Date(Date.parse(r.checkout_at) + CHECKOUT_HOLD_MS).toISOString() : null });
    }
  }
  // Placements made by hand hold their days too, under the fields recorded for them (notePlacementFields).
  // was: only orders' roles counted, so the cap the terms promise could be passed by hand-made ones.
  const manual = await db.prepare(
    "SELECT p.id AS placement_id, p.listing_id, p.start_day, p.end_day, f.fields FROM placements p LEFT JOIN placement_fields f ON f.placement_id = p.id " +
    `WHERE p.status IN (${HOLDING.map(() => "?").join(", ")}) AND ${NOT_ORDERED}`,
  ).bind(...HOLDING).all();
  for (const r of manual.results) {
    held.push({ order: "manual:" + r.placement_id, listing: r.listing_id, fields: fieldsOf(String(r.fields || "").split(",").filter(Boolean)), start: r.start_day, end: r.end_day, expires: null });
  }
  return held;
}

async function reserveCapacity(db, order, roles, start, now, expires = null) {
  const at = now.toISOString();
  const held = await heldRoles(db, now, order.id);
  const fit = fitAll(held, roles, start);
  if (!fit.fits) throw conflict("full", "Those dates no longer have room. Choose other dates or refuse and refund the order.",
    { next_start: firstFit(held, roles, start) });
  const rows = [];
  for (const h of [...held, ...roles.map(r => ({ order: order.id, listing: r.id, fields: r.fields,
    start, end: addDays(start, DAYS), expires }))]) {
    if (h.order.startsWith("manual:")) continue; // Read and reserve these inside the transaction below.
    for (let day = h.start < dayOf(now) ? dayOf(now) : h.start; day < h.end; day = addDays(day, 1)) {
      for (const field of h.fields) rows.push({ order: h.order, listing: h.listing, field, day, expires: h.expires });
    }
  }
  try {
    await db.batch([
      db.prepare("DELETE FROM employer_capacity_reservations WHERE expires_at <= ? OR day < ? OR order_id IN " +
        "(SELECT id FROM employer_orders WHERE status = 'refused') OR EXISTS " +
        "(SELECT 1 FROM employer_order_roles r JOIN placements p ON p.id = r.placement_id " +
        "WHERE r.order_id = employer_capacity_reservations.order_id AND r.listing_id = employer_capacity_reservations.listing_id " +
        "AND p.status IN ('ended', 'refused'))").bind(at, dayOf(now)),
      db.prepare("DELETE FROM employer_capacity_reservations WHERE order_id = ?").bind(order.id),
      db.prepare("DELETE FROM employer_capacity_reservations WHERE order_id LIKE 'manual:%'"),
      db.prepare("WITH RECURSIVE days(order_id, listing_id, fields, day, end_day) AS (" +
        "SELECT 'manual:' || p.id, p.listing_id, COALESCE(NULLIF(f.fields, ''), 'other'), MAX(p.start_day, ?), p.end_day " +
        "FROM placements p LEFT JOIN placement_fields f ON f.placement_id = p.id " +
        `WHERE p.status IN ('draft', 'checked', 'on', 'paused') AND p.end_day > ? AND ${NOT_ORDERED} ` +
        "UNION ALL SELECT order_id, listing_id, fields, date(day, '+1 day'), end_day FROM days WHERE date(day, '+1 day') < end_day) " +
        "INSERT OR IGNORE INTO employer_capacity_reservations (order_id, listing_id, field, day, expires_at, checked_at) " +
        "SELECT order_id, listing_id, j.value, day, NULL, ? FROM days JOIN json_each('[\"' || replace(fields, ',', '\",\"') || '\"]') j")
        .bind(dayOf(now), dayOf(now), at),
      db.prepare("INSERT OR IGNORE INTO employer_capacity_reservations (order_id, listing_id, field, day, expires_at, checked_at) " +
        "SELECT json_extract(value,'$.order'), json_extract(value,'$.listing'), json_extract(value,'$.field'), " +
        "json_extract(value,'$.day'), json_extract(value,'$.expires'), ? FROM json_each(?)")
        .bind(at, JSON.stringify(rows)),
    ]);
  } catch (e) {
    if (/employer_capacity_full|employer_listing_taken/.test(String(e))) {
      throw conflict("full", "Those dates were reserved a moment ago. Please choose other dates.");
    }
    throw e;
  }
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
  const selected = [...new Set(ids)].map(id => index.get(id)).filter(Boolean).map(r => ({ id: r.id, fields: fieldsOf(r.f) }));
  const fits = new Map(fitAll(held, selected, start).roles.map(r => [r.id, r]));
  return {
    start,
    roles: [...new Set(ids)].map((id) => {
      const r = index.get(id);
      if (!r) return { id, listed: false };
      const role = { id, fields: fieldsOf(r.f) };
      const fit = fits.get(id);
      return fit.fits ? { id, listed: true, fits: true } : { ...fit, listed: true, next_start: firstFit(held, selected, start) };
    }),
  };
}

export { busiest, fillPlacementFields, firstFit, fitAll, heldRoles, reserveCapacity, startDay };
