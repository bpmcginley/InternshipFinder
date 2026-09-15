// Allowance, per-run, rate and budget checks over D1. Counters only, never request content.
import { HttpError } from "./http.js";

export const monthOf = (d) => d.toISOString().slice(0, 7);

export const nextMonth = (d) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);

// The MONTHLY_BUDGET_CENTS var wins over config; "0" pauses AI right away.
export function budgetCents(env, config) {
  const v = env.MONTHLY_BUDGET_CENTS;
  return v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : config.MONTHLY_BUDGET_CENTS;
}

export async function spend(db, month) {
  const row = await db.prepare("SELECT spend_cents FROM budget WHERE month = ?").bind(month).first();
  return row ? row.spend_cents : 0;
}

export async function isPaused(db, env, config, now) {
  return (await spend(db, monthOf(now))) >= budgetCents(env, config);
}

export async function addSpend(db, month, cents) {
  if (!(cents > 0)) return;
  await db.prepare(
    "INSERT INTO budget (month, spend_cents) VALUES (?, ?) " +
    "ON CONFLICT(month) DO UPDATE SET spend_cents = spend_cents + excluded.spend_cents",
  ).bind(month, cents).run();
}

export async function usageFor(db, user, month) {
  const { results } = await db.prepare("SELECT task, units FROM usage WHERE user_hash = ? AND month = ?")
    .bind(user, month).all();
  return Object.fromEntries(results.map((r) => [r.task, r.units]));
}

// Monthly units for a task: the full table for "edu", GENERAL_ALLOWANCE_PCT of it (min 1) for "general".
export function allowanceFor(config, env, task, tier) {
  const base = config.TASKS[task].allowance;
  if (tier === "edu") return base;
  const raw = Number(env.GENERAL_ALLOWANCE_PCT);
  const pct = env.GENERAL_ALLOWANCE_PCT !== undefined && env.GENERAL_ALLOWANCE_PCT !== "" && Number.isFinite(raw)
    ? Math.min(100, Math.max(0, raw)) : 50;
  return Math.max(1, Math.floor((base * pct) / 100));
}

// Checks budget, rate and allowance for one /ai call, then counts it in the rate buckets.
export async function admit(db, env, config, user, task, runId, now, tier = "general") {
  const month = monthOf(now);
  if ((await spend(db, month)) >= budgetCents(env, config)) {
    throw new HttpError(503, "paused", "AI features are paused until next month because the budget is used up. Search still works.");
  }

  const iso = now.toISOString();
  const minute = "m:" + iso.slice(0, 16);
  const day = "d:" + iso.slice(0, 10);
  const { results } = await db.prepare("SELECT bucket, calls FROM rate WHERE user_hash = ? AND bucket IN (?, ?)")
    .bind(user, minute, day).all();
  const calls = Object.fromEntries(results.map((r) => [r.bucket, r.calls]));
  if ((calls[minute] || 0) >= config.RATE.perMinute) {
    throw new HttpError(429, "rate", "Too many AI calls this minute", { retry_after: 60 - now.getUTCSeconds() });
  }
  if ((calls[day] || 0) >= config.RATE.perDay) {
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    throw new HttpError(429, "rate", "Daily AI call limit reached", { retry_after: Math.ceil((midnight - now.getTime()) / 1000) });
  }

  const limit = allowanceFor(config, env, task, tier);
  const run = await db.prepare("SELECT calls FROM runs WHERE user_hash = ? AND month = ? AND task = ? AND run_id = ?")
    .bind(user, month, task, runId).first();
  const row = await db.prepare("SELECT units FROM usage WHERE user_hash = ? AND month = ? AND task = ?")
    .bind(user, month, task).first();
  const used = row ? row.units : 0;
  const cap = (msg) => new HttpError(429, "cap", msg, { task, resets: nextMonth(now) });
  if (run && run.calls >= config.MAX_CALLS_PER_RUN) throw cap("This run reached its call limit");
  if (!run && used >= limit) throw cap(`Monthly ${task} allowance is used up`);

  const bump = "INSERT INTO rate (user_hash, bucket, calls) VALUES (?, ?, 1) " +
    "ON CONFLICT(user_hash, bucket) DO UPDATE SET calls = calls + 1";
  await db.batch([db.prepare(bump).bind(user, minute), db.prepare(bump).bind(user, day)]);
  return { month, used, limit };
}

// Counts a call Gemini accepted: +1 call on the run, and +1 unit if the run is new.
// Returns units left for the task this month.
export async function commitRun(db, user, task, runId, admitted) {
  const { month, used, limit } = admitted;
  const ins = await db.prepare("INSERT OR IGNORE INTO runs (user_hash, month, task, run_id, calls) VALUES (?, ?, ?, ?, 1)")
    .bind(user, month, task, runId).run();
  const isNew = ins.meta.changes > 0;
  if (isNew) {
    await db.prepare(
      "INSERT INTO usage (user_hash, month, task, units) VALUES (?, ?, ?, 1) " +
      "ON CONFLICT(user_hash, month, task) DO UPDATE SET units = units + 1",
    ).bind(user, month, task).run();
  } else {
    await db.prepare("UPDATE runs SET calls = calls + 1 WHERE user_hash = ? AND month = ? AND task = ? AND run_id = ?")
      .bind(user, month, task, runId).run();
  }
  return Math.max(0, limit - used - (isNew ? 1 : 0));
}

export async function deleteUser(db, user) {
  await db.batch(["usage", "runs", "rate", "demand"].map((t) =>
    db.prepare(`DELETE FROM ${t} WHERE user_hash = ?`).bind(user)));
}

// Daily cron: old rate buckets, last month's runs, usage older than a year.
export async function cleanup(db, now) {
  const day = new Date(now.getTime() - 2 * 86400e3).toISOString().slice(0, 10);
  const yearAgo = monthOf(new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1)));
  await db.batch([
    db.prepare("DELETE FROM rate WHERE bucket >= 'd:' AND bucket < ?").bind("d:" + day),
    db.prepare("DELETE FROM rate WHERE bucket >= 'm:' AND bucket < ?").bind("m:" + day),
    db.prepare("DELETE FROM runs WHERE month < ?").bind(monthOf(now)),
    db.prepare("DELETE FROM usage WHERE month < ?").bind(yearAgo),
  ]);
}
