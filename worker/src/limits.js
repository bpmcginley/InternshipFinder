// Allowance, per-run, rate and budget checks over D1. Counters only, never request content.
import { HttpError } from "./http.js";
import { canUpgrade } from "./billing.js";

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

// The deployment-wide rate bucket shares the rate table under a sentinel that no real user_hash can
// collide with (those are sha256 hex), so the existing bucket-prefix cleanup sweeps it for free.
export const GLOBAL_USER = "*";

// Whole-deployment ceiling per minute; the GLOBAL_RPM var wins over config. "0" turns AI off now.
export function globalRpm(env, config) {
  const v = env.GLOBAL_RPM;
  if (v !== undefined && v !== "" && Number.isFinite(Number(v))) return Number(v);
  // Absent from config means no deployment-wide ceiling. Stated as Infinity rather than left
  // undefined so the comparison is a real one and not a NaN that silently never fires.
  const c = config.RATE.globalPerMinute;
  return Number.isFinite(c) ? c : Infinity;
}

export async function usageFor(db, user, month) {
  const { results } = await db.prepare("SELECT task, units FROM usage WHERE user_hash = ? AND month = ?")
    .bind(user, month).all();
  return Object.fromEntries(results.map((r) => [r.task, r.units]));
}

// The .edu free allowance for a task on a date: TASKS, overridden by any ALLOWANCE_CHANGES already in force
function tableAllowance(config, task, now) {
  const day = now.toISOString().slice(0, 10);
  let units = config.TASKS[task].allowance;
  for (const c of config.ALLOWANCE_CHANGES || []) {
    if (day >= c.from && c.tasks[task] !== undefined) units = c.tasks[task];
  }
  return units;
}

// Monthly units for a task: the full table for "edu", GENERAL_ALLOWANCE_PCT of it (min 1) for "general".
// null when the task has no monthly cap.
export function allowanceFor(config, env, task, tier, plan = "free", now = new Date()) {
  const units = tableAllowance(config, task, now);
  if (units == null) return null;
  const mult = (config.PLANS[plan] || config.PLANS.free).multiplier;
  // Rounded because a multiplier can be fractional: a plan is priced against what AI actually costs,
  // not against whole numbers.
  const base = Math.round(units * mult);
  if (tier === "edu") return base;
  const raw = Number(env.GENERAL_ALLOWANCE_PCT);
  const pct = env.GENERAL_ALLOWANCE_PCT !== undefined && env.GENERAL_ALLOWANCE_PCT !== "" && Number.isFinite(raw)
    ? Math.min(100, Math.max(0, raw)) : 50;
  return Math.max(1, Math.floor((base * pct) / 100));
}

// Checks budget, rate and allowance for one /ai call, then counts it in the rate buckets.
export async function admit(db, env, config, user, task, runId, now, tier = "general", plan = "free") {
  const rate = (config.PLANS[plan] || config.PLANS.free).rate || config.RATE;
  const month = monthOf(now);
  if ((await spend(db, month)) >= budgetCents(env, config)) {
    throw new HttpError(503, "paused", "AI features are paused until next month because the budget is used up. Search still works.");
  }

  const iso = now.toISOString();
  const minute = "m:" + iso.slice(0, 16);
  const day = "d:" + iso.slice(0, 10);
  const { results } = await db.prepare(
    "SELECT user_hash, bucket, calls FROM rate WHERE (user_hash = ? AND bucket IN (?, ?)) OR (user_hash = ? AND bucket = ?)")
    .bind(user, minute, day, GLOBAL_USER, minute).all();
  const calls = Object.fromEntries(results.filter((r) => r.user_hash === user).map((r) => [r.bucket, r.calls]));
  const globalCalls = (results.find((r) => r.user_hash === GLOBAL_USER) || {}).calls || 0;
  const untilNextMinute = 60 - now.getUTCSeconds();
  if ((calls[minute] || 0) >= rate.perMinute) {
    throw new HttpError(429, "rate", "Too many AI calls this minute", { retry_after: untilNextMinute });
  }
  // Checked after the student's own limit so that someone who is genuinely over their own rate hears
  // that, not a server-busy message. 503 not 429: this one is not their fault and is worth retrying.
  if (globalCalls >= globalRpm(env, config)) {
    throw new HttpError(503, "busy", "InternScout is handling a lot of AI requests right now. Try again in a minute.",
                        { retry_after: untilNextMinute });
  }
  if ((calls[day] || 0) >= rate.perDay) {
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    throw new HttpError(429, "rate", "Daily AI call limit reached", { retry_after: Math.ceil((midnight - now.getTime()) / 1000) });
  }

  const limit = allowanceFor(config, env, task, tier, plan, now);
  const run = await db.prepare("SELECT calls FROM runs WHERE user_hash = ? AND month = ? AND task = ? AND run_id = ?")
    .bind(user, month, task, runId).first();
  const row = await db.prepare("SELECT units FROM usage WHERE user_hash = ? AND month = ? AND task = ?")
    .bind(user, month, task).first();
  const used = row ? row.units : 0;
  // The client uses `upgrade` to decide whether to mention a paid plan; it never guesses.
  // `upgrade` tells the client whether a bigger plan exists for this student, so it never offers one
  // that is switched off or that they are already on.
  // `tier` lets the client skip "a .edu email gets twice as much" for a student who already has one.
  const cap = (msg) => new HttpError(429, "cap", msg, { task, resets: nextMonth(now), upgrade: canUpgrade(env, config, plan), tier });
  if (run && run.calls >= config.MAX_CALLS_PER_RUN) throw cap("This run reached its call limit");
  if (!run && limit != null && used >= limit) throw cap(`Monthly ${task} allowance is used up`);

  const bump = "INSERT INTO rate (user_hash, bucket, calls) VALUES (?, ?, 1) " +
    "ON CONFLICT(user_hash, bucket) DO UPDATE SET calls = calls + 1";
  await db.batch([db.prepare(bump).bind(user, minute), db.prepare(bump).bind(user, day),
                  db.prepare(bump).bind(GLOBAL_USER, minute)]);
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
  if (limit == null) return "unlimited";   // the X-InternScout-Remaining header for an uncapped task
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
    // Webhook ids are only needed for as long as Stripe retries an event (hours, not weeks).
    db.prepare("DELETE FROM stripe_events WHERE seen < ?").bind(new Date(now.getTime() - 30 * 86400e3).toISOString()),
  ]);
}
