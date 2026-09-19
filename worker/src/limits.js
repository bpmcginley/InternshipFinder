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

// What one account may spend in a month, in cents. A plan's row in USER_BUDGET_CENTS, scaled like the
// allowances for a "general" account. null means no per-account ceiling.
export function userBudgetCents(config, env, tier, plan = "free") {
  const table = config.USER_BUDGET_CENTS;
  if (!table) return null;
  const cents = table[plan] ?? table.free;
  if (cents == null) return null;
  if (tier === "edu" || plan !== "free") return cents;
  const raw = Number(env.GENERAL_ALLOWANCE_PCT);
  const pct = env.GENERAL_ALLOWANCE_PCT !== undefined && env.GENERAL_ALLOWANCE_PCT !== "" && Number.isFinite(raw)
    ? Math.min(100, Math.max(0, raw)) : 50;
  return (cents * pct) / 100;
}

// +1 on a rate bucket unless it is already at its limit. One statement, so parallel calls cannot all
// read "9 of 10" and all pass. false means the bucket is full and nothing was counted.
async function bumpUnder(db, user, bucket, limit) {
  if (!(limit > 0)) return false;
  if (limit === Infinity) limit = Number.MAX_SAFE_INTEGER;
  const r = await db.prepare(
    "INSERT INTO rate (user_hash, bucket, calls) VALUES (?, ?, 1) " +
    "ON CONFLICT(user_hash, bucket) DO UPDATE SET calls = calls + 1 WHERE calls < ?",
  ).bind(user, bucket, limit).run();
  return r.meta.changes > 0;
}

// Checks budget, rate, allowance and the account's own spend ceiling for one /ai call, and counts the
// call as it checks: every check is a single conditional write, so a burst of parallel calls cannot
// slip past a limit between a read and a write. `estimate` (cents) is charged up front and corrected
// by settle() once Gemini says what the call really cost; release() undoes it all if Gemini fails.
// A Worker that dies in between leaves the unit and the estimate counted, which errs on the safe side.
export async function admit(db, env, config, user, task, runId, now, tier = "general", plan = "free", estimate = 0) {
  const rate = (config.PLANS[plan] || config.PLANS.free).rate || config.RATE;
  const month = monthOf(now);
  if ((await spend(db, month)) >= budgetCents(env, config)) {
    throw new HttpError(503, "paused", "AI features are paused until next month because the budget is used up. Search still works.");
  }

  const iso = now.toISOString();
  const minute = "m:" + iso.slice(0, 16);
  const day = "d:" + iso.slice(0, 10);
  const untilNextMinute = 60 - now.getUTCSeconds();
  if (!(await bumpUnder(db, user, minute, rate.perMinute))) {
    throw new HttpError(429, "rate", "Too many AI calls this minute", { retry_after: untilNextMinute });
  }
  if (!(await bumpUnder(db, user, day, rate.perDay))) {
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    throw new HttpError(429, "rate", "Daily AI call limit reached", { retry_after: Math.ceil((midnight - now.getTime()) / 1000) });
  }
  // Checked after the student's own limits so that someone who is genuinely over their own rate hears
  // that, not a server-busy message, and so a client hammering past its own limit adds nothing to the
  // shared bucket. 503 not 429: this one is not their fault and is worth retrying.
  if (!(await bumpUnder(db, GLOBAL_USER, minute, globalRpm(env, config)))) {
    // Not their doing, so it does not come out of their own minute or day either.
    await db.prepare("UPDATE rate SET calls = calls - 1 WHERE user_hash = ? AND bucket IN (?, ?) AND calls > 0")
      .bind(user, minute, day).run();
    throw new HttpError(503, "busy", "InternScout is handling a lot of AI requests right now. Try again in a minute.",
                        { retry_after: untilNextMinute });
  }

  const limit = allowanceFor(config, env, task, tier, plan, now);
  // The client uses `upgrade` to decide whether to mention a paid plan; it never guesses.
  // `upgrade` tells the client whether a bigger plan exists for this student, so it never offers one
  // that is switched off or that they are already on.
  // `tier` lets the client skip "a .edu email gets twice as much" for a student who already has one.
  const cap = (msg) => new HttpError(429, "cap", msg, { task, resets: nextMonth(now), upgrade: canUpgrade(env, config, plan), tier });

  const runKey = [user, month, task, runId];
  const ins = await db.prepare("INSERT OR IGNORE INTO runs (user_hash, month, task, run_id, calls) VALUES (?, ?, ?, ?, 0)")
    .bind(...runKey).run();
  const isNew = ins.meta.changes > 0;
  let used;
  if (isNew) {
    // A new run costs a unit. The WHERE makes "is there one left" and "take it" the same statement.
    const row = limit != null && !(limit > 0) ? null : await db.prepare(
      "INSERT INTO usage (user_hash, month, task, units) VALUES (?, ?, ?, 1) " +
      "ON CONFLICT(user_hash, month, task) DO UPDATE SET units = units + 1 WHERE units < ? RETURNING units",
    ).bind(user, month, task, limit == null ? Number.MAX_SAFE_INTEGER : limit).first();
    if (!row) {
      await db.prepare("DELETE FROM runs WHERE user_hash = ? AND month = ? AND task = ? AND run_id = ?").bind(...runKey).run();
      throw cap(`Monthly ${task} allowance is used up`);
    }
    used = row.units;
  } else {
    const row = await db.prepare("SELECT units FROM usage WHERE user_hash = ? AND month = ? AND task = ?")
      .bind(user, month, task).first();
    used = row ? row.units : 0;
  }
  const call = await db.prepare(
    "UPDATE runs SET calls = calls + 1 WHERE user_hash = ? AND month = ? AND task = ? AND run_id = ? AND calls < ?",
  ).bind(...runKey, config.MAX_CALLS_PER_RUN).run();
  if (call.meta.changes === 0) throw cap("This run reached its call limit");

  const admitted = { month, used, limit, isNew, estimate: estimate > 0 ? estimate : 0, metered: false };
  // The account's own ceiling. Without it the only thing between one modified client and the whole
  // month's budget is the daily rate limit: a task with no unit cap, a fresh run_id per call and a
  // large body would pause AI for everyone. It is set well above what a full allowance costs, so a
  // student using the extension as built never meets it.
  const ceiling = userBudgetCents(config, env, tier, plan);
  if (ceiling != null) {
    const ok = ceiling > 0 && (await db.prepare(
      "INSERT INTO spend (user_hash, month, cents) VALUES (?, ?, ?) " +
      "ON CONFLICT(user_hash, month) DO UPDATE SET cents = cents + excluded.cents WHERE cents < ?",
    ).bind(user, month, admitted.estimate, ceiling).run()).meta.changes > 0;
    if (!ok) {
      await release(db, user, task, runId, { ...admitted, estimate: 0 });
      throw cap("This account reached its monthly AI ceiling");
    }
    admitted.metered = true;
  }
  await addSpend(db, month, admitted.estimate);
  return admitted;
}

// Units left for the task this month, for the X-InternScout-Remaining header.
export function remainingOf(admitted) {
  if (admitted.limit == null) return "unlimited";
  return Math.max(0, admitted.limit - admitted.used);
}

// Gemini refused or could not be reached: give back the unit, the call and the estimate. The rate
// buckets keep their count, since the call was made.
export async function release(db, user, task, runId, admitted) {
  const { month, isNew, estimate, metered } = admitted;
  const stmts = [];
  if (isNew) {
    stmts.push(db.prepare("DELETE FROM runs WHERE user_hash = ? AND month = ? AND task = ? AND run_id = ?").bind(user, month, task, runId));
    stmts.push(db.prepare("UPDATE usage SET units = units - 1 WHERE user_hash = ? AND month = ? AND task = ? AND units > 0").bind(user, month, task));
  } else {
    stmts.push(db.prepare("UPDATE runs SET calls = calls - 1 WHERE user_hash = ? AND month = ? AND task = ? AND run_id = ? AND calls > 0")
      .bind(user, month, task, runId));
  }
  if (estimate > 0) {
    stmts.push(db.prepare("UPDATE budget SET spend_cents = MAX(0, spend_cents - ?) WHERE month = ?").bind(estimate, month));
    if (metered) stmts.push(db.prepare("UPDATE spend SET cents = MAX(0, cents - ?) WHERE user_hash = ? AND month = ?").bind(estimate, user, month));
  }
  await db.batch(stmts);
}

// Replaces the estimate charged at admission with what the call really cost, for the whole deployment
// and for the account, and adds the call's token counts to the month's totals (numbers only), so the
// share of input served from Gemini's cache can be read off one row.
export async function settle(db, user, admitted, cents, usage) {
  const { month, estimate, metered } = admitted;
  const delta = (cents > 0 ? cents : 0) - estimate;
  const stmts = [];
  if (delta !== 0) {
    stmts.push(db.prepare(
      "INSERT INTO budget (month, spend_cents) VALUES (?, MAX(0, ?)) " +
      "ON CONFLICT(month) DO UPDATE SET spend_cents = MAX(0, spend_cents + ?)").bind(month, delta, delta));
    if (metered) {
      stmts.push(db.prepare("UPDATE spend SET cents = MAX(0, cents + ?) WHERE user_hash = ? AND month = ?").bind(delta, user, month));
    }
  }
  if (usage) {
    const n = (k) => Math.max(0, Math.floor(Number(usage[k]) || 0));
    stmts.push(db.prepare(
      "INSERT INTO tokens (month, calls, prompt, cached, output) VALUES (?, 1, ?, ?, ?) " +
      "ON CONFLICT(month) DO UPDATE SET calls = calls + 1, prompt = prompt + excluded.prompt, " +
      "cached = cached + excluded.cached, output = output + excluded.output",
    ).bind(month, n("promptTokenCount"), n("cachedContentTokenCount"), n("candidatesTokenCount") + n("thoughtsTokenCount")));
  }
  if (stmts.length) await db.batch(stmts);
}

// "Delete my data". Chosen states, earlier months and the plan row go at once. This month's counters
// stay until the month ends: they are a hashed id and numbers, and deleting them on request would let
// anyone at a limit reset it by deleting and signing in again. The `forget` row has the daily cron
// remove them as soon as the month is over.
export async function deleteUser(db, user, now = new Date()) {
  const month = monthOf(now);
  await db.batch([
    db.prepare("DELETE FROM demand WHERE user_hash = ?").bind(user),
    db.prepare("DELETE FROM usage WHERE user_hash = ? AND month < ?").bind(user, month),
    db.prepare("DELETE FROM runs WHERE user_hash = ? AND month < ?").bind(user, month),
    db.prepare("DELETE FROM spend WHERE user_hash = ? AND month < ?").bind(user, month),
    db.prepare("INSERT INTO forget (user_hash, month) VALUES (?, ?) ON CONFLICT(user_hash) DO UPDATE SET month = excluded.month")
      .bind(user, month),
  ]);
}

// Daily cron: old rate buckets, last month's runs and per-account spend, usage older than a year.
export async function cleanup(db, now) {
  const day = new Date(now.getTime() - 2 * 86400e3).toISOString().slice(0, 10);
  const yearAgo = monthOf(new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1)));
  await db.batch([
    db.prepare("DELETE FROM rate WHERE bucket >= 'd:' AND bucket < ?").bind("d:" + day),
    db.prepare("DELETE FROM rate WHERE bucket >= 'm:' AND bucket < ?").bind("m:" + day),
    db.prepare("DELETE FROM runs WHERE month < ?").bind(monthOf(now)),
    db.prepare("DELETE FROM spend WHERE month < ?").bind(monthOf(now)),
    // Accounts that asked to be deleted: the counters kept to the end of that month go now.
    db.prepare("DELETE FROM usage WHERE month < ? AND user_hash IN (SELECT user_hash FROM forget WHERE month < ?)")
      .bind(monthOf(now), monthOf(now)),
    db.prepare("DELETE FROM forget WHERE month < ?").bind(monthOf(now)),
    db.prepare("DELETE FROM usage WHERE month < ?").bind(yearAgo),
    // Webhook ids are only needed for as long as Stripe retries an event (hours, not weeks).
    db.prepare("DELETE FROM stripe_events WHERE seen < ?").bind(new Date(now.getTime() - 30 * 86400e3).toISOString()),
  ]);
}
