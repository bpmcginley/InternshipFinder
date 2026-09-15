// Area demand: the states signed-in students want. One row per user, replaced on change.
import { HttpError } from "./http.js";

export const STATES = new Set((
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY " +
  "NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR GU VI AS MP REMOTE"
).split(" "));

export function cleanStates(body) {
  const list = body && body.states;
  if (!Array.isArray(list) || list.length > 60) {
    throw new HttpError(400, "bad_request", "states must be an array of at most 60 codes");
  }
  const out = [...new Set(list.map((s) => String(s).trim().toUpperCase()))];
  if (out.some((s) => !STATES.has(s))) {
    throw new HttpError(400, "bad_request", "states must be USPS codes or REMOTE");
  }
  return out.sort();
}

export async function setDemand(db, user, states, now) {
  const t = now.toISOString();
  await db.prepare(
    "INSERT INTO demand (user_hash, states, updated, seen) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(user_hash) DO UPDATE SET states = excluded.states, updated = excluded.updated, seen = excluded.seen",
  ).bind(user, JSON.stringify(states), t, t).run();
}

// Marks the user active, at most one write a day, so the 90-day window stays current.
export async function touchSeen(db, user, now) {
  const t = now.toISOString();
  await db.prepare("UPDATE demand SET seen = ? WHERE user_hash = ? AND seen < ?").bind(t, user, t.slice(0, 10)).run();
}

const windowStart = (config, now) => new Date(now.getTime() - config.DEMAND_WINDOW_DAYS * 86400e3).toISOString();

export async function demandCounts(db, config, now) {
  const { results } = await db.prepare("SELECT states FROM demand WHERE seen >= ?").bind(windowStart(config, now)).all();
  const states = {};
  for (const r of results) {
    let list = [];
    try {
      list = JSON.parse(r.states);
    } catch {}
    for (const s of list) states[s] = (states[s] || 0) + 1;
  }
  return { states, users: results.length, updated: now.toISOString().replace(/\.\d{3}Z$/, "Z") };
}

// Daily cron: forget users who haven't been active in the window.
export async function dropStale(db, config, now) {
  await db.prepare("DELETE FROM demand WHERE seen < ?").bind(windowStart(config, now)).run();
}
