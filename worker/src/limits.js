// Allowance, per-run, rate and budget checks over D1. Counters only, never request content.
import { HttpError } from "./http.js";
import { canUpgrade } from "./billing.js";
import { forgetStatements } from "./referral.js";

export const monthOf = (d) => d.toISOString().slice(0, 7);

// The UTC day, for the day's share of the budget. Ten characters against a month's seven, so a day
// key and a month key can never name the same row even where they share a column.
export const dayOf = (d) => d.toISOString().slice(0, 10);

export const nextMonth = (d) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);

// The MONTHLY_BUDGET_CENTS var wins over config; "0" pauses AI right away.
export function budgetCents(env, config) {
  const v = env.MONTHLY_BUDGET_CENTS;
  return v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : config.MONTHLY_BUDGET_CENTS;
}

// The same shape one step down: the DAILY_BUDGET_CENTS var wins over config, and "0" pauses AI for
// the rest of today. A null in config means a thirtieth of whatever the monthly figure is (250c of
// the $75 month), so raising MONTHLY_BUDGET_CENTS raises the day with it and the two cannot drift.
// Without this, a month with no daily smoothing can all go on launch day: at ~$0.06 an auto-filled
// application and a 150c per-account ceiling, about fifty heavy free accounts empty the $75, and
// every student who arrives after them meets a dead product until the 1st.
export function dailyBudgetCents(env, config) {
  const v = env.DAILY_BUDGET_CENTS;
  if (v !== undefined && v !== "" && Number.isFinite(Number(v))) return Number(v);
  const c = config.DAILY_BUDGET_CENTS;
  return c != null && Number.isFinite(c) ? c : budgetCents(env, config) / 30;
}

export async function spend(db, month) {
  const row = await db.prepare("SELECT spend_cents FROM budget WHERE month = ?").bind(month).first();
  return row ? row.spend_cents : 0;
}

// Answers for the day's stop as well as the month's, so /config and /me never tell a student AI is
// available on a day whose share is already spent and then have /ai turn them away with a 503.
// was: export async function isPaused(db, env, config, now) {
// `plan` because admit() applies the day's stop to free plans only (see the day's charge there), so
// asking without it would tell a paying student AI is paused on a day that /ai would serve them.
// The default is "free": /config is answered before anyone has signed in, and there the free answer
// is the honest one. A caller that knows the student's plan should pass it.
export async function isPaused(db, env, config, now, plan = "free") {
  // was: return (await spend(db, monthOf(now))) >= budgetCents(env, config);
  if ((await spend(db, monthOf(now))) >= budgetCents(env, config)) return true;
  if (plan !== "free") return false;
  return (await daySpend(db, dayOf(now))) >= dailyBudgetCents(env, config);
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

// was: // Today's deployment-wide spend shares the `spend` table under that same sentinel. A day key
// Today's spend by free accounts (admit() charges this row for free plans only, so a paid student is
// never paused by it) shares the `spend` table under that same sentinel. A day key
// ("2026-09-14") cannot collide with the month key a real account's row carries ("2026-09"), and the
// month-end sweep in cleanup() already drops every spend row from a past month, so these are cleaned
// up for free and at most thirty of them exist at once. A table of its own would mean a D1 migration
// against the live database for a number that is thrown away every month anyway.
export async function daySpend(db, day) {
  const row = await db.prepare("SELECT cents FROM spend WHERE user_hash = ? AND month = ?").bind(GLOBAL_USER, day).first();
  return row ? row.cents : 0;
}

// was: export async function addDaySpend(db, day, cents) {
// was:   if (!(cents > 0)) return;
// was:   await db.prepare(
// was:     "INSERT INTO spend (user_hash, month, cents) VALUES (?, ?, ?) " +
// was:     "ON CONFLICT(user_hash, month) DO UPDATE SET cents = cents + excluded.cents",
// was:   ).bind(GLOBAL_USER, day, cents).run();
// was: }
// Adds `cents` to the day's row unless that row is already at `limit`, and answers whether it went
// in. One statement, the shape bumpUnder further down uses, because the pair it replaces (read the
// figure in admit(), write it seven D1 round trips later) let every call in a burst read the same
// stale figure and every one of them pass: at the 120 calls a minute GLOBAL_RPM allows and ~6c an
// estimate, one minute could put ~720c against a 250c day. false means the day is spent and nothing
// was written, so a caller acting on false must not give anything back here.
// A limit of 0 is "no AI today" and must refuse even when no row exists yet, which the INSERT on its
// own would not: an insert of 0 cents into an empty day counts as a change and would pass.
export async function addDaySpendUnder(db, day, cents, limit) {
  if (!(limit > 0)) return false;
  const r = await db.prepare(
    "INSERT INTO spend (user_hash, month, cents) VALUES (?, ?, ?) " +
    "ON CONFLICT(user_hash, month) DO UPDATE SET cents = cents + excluded.cents WHERE cents < ?",
  ).bind(GLOBAL_USER, day, cents > 0 ? cents : 0, limit).run();
  return r.meta.changes > 0;
}

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
  const today = dayOf(now);
  if ((await spend(db, month)) >= budgetCents(env, config)) {
    throw new HttpError(503, "paused", "AI features are paused until next month because the budget is used up. Search still works.");
  }
  // was: // Checked after the month's stop so a genuinely empty month still says "until next month". This one
  // was: // only costs the student the rest of today, which is the whole point of it: before the day's share
  // was: // existed the month could be emptied in an afternoon and the next student had nothing until the 1st.
  // was: if ((await daySpend(db, today)) >= dailyBudgetCents(env, config)) {
  // was:   const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  // was:   throw new HttpError(503, "paused",
  // was:                       "AI features are paused until tomorrow because today's share of the budget is used up. Search still works.",
  // was:                       { retry_after: Math.ceil((midnight - now.getTime()) / 1000) });
  // was: }
  // The day's stop moved to the bottom of this function, where charging the day and checking it are
  // the same statement; reading it here and writing it seven round trips later was a read-then-act a
  // burst could walk straight through. It still comes after the month's stop above, so a genuinely
  // empty month still says "until next month" rather than "until tomorrow".

  const iso = now.toISOString();
  const minute = "m:" + iso.slice(0, 16);
  // was: const day = "d:" + iso.slice(0, 10);
  // `dayBucket`, not `day`: this is the rate table's key ("d:2026-09-14"), while `today` above and
  // `admitted.day` below are the plain date ("2026-09-14") that the spend table keys on. The two
  // sat a few lines apart under names that both read as "day".
  const dayBucket = "d:" + iso.slice(0, 10);
  const untilNextMinute = 60 - now.getUTCSeconds();
  if (!(await bumpUnder(db, user, minute, rate.perMinute))) {
    throw new HttpError(429, "rate", "Too many AI calls this minute", { retry_after: untilNextMinute });
  }
  // was: if (!(await bumpUnder(db, user, day, rate.perDay))) {
  if (!(await bumpUnder(db, user, dayBucket, rate.perDay))) {
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    throw new HttpError(429, "rate", "Daily AI call limit reached", { retry_after: Math.ceil((midnight - now.getTime()) / 1000) });
  }
  // Checked after the student's own limits so that someone who is genuinely over their own rate hears
  // that, not a server-busy message, and so a client hammering past its own limit adds nothing to the
  // shared bucket. 503 not 429: this one is not their fault and is worth retrying.
  if (!(await bumpUnder(db, GLOBAL_USER, minute, globalRpm(env, config)))) {
    // Not their doing, so it does not come out of their own minute or day either.
    await db.prepare("UPDATE rate SET calls = calls - 1 WHERE user_hash = ? AND bucket IN (?, ?) AND calls > 0")
      // was: .bind(user, minute, day).run();
      .bind(user, minute, dayBucket).run();
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
  let bonusTook = false;
  if (isNew) {
    // A new run costs a unit. The WHERE makes "is there one left" and "take it" the same statement.
    let row = limit != null && !(limit > 0) ? null : await db.prepare(
      "INSERT INTO usage (user_hash, month, task, units) VALUES (?, ?, ?, 1) " +
      "ON CONFLICT(user_hash, month, task) DO UPDATE SET units = units + 1 WHERE units < ? RETURNING units",
    ).bind(user, month, task, limit == null ? Number.MAX_SAFE_INTEGER : limit).first();
    // The month's units are gone: an invite's extra units (referral.js) come next, taken the same way,
    // one statement that checks and spends. Only where the task has a real allowance: a limit of 0 is
    // the task switched off, which extra units must not switch back on. The unit still goes on the
    // month's usage row, so /me can say how many were used this month.
    if (!row && limit > 0) {
      const extra = await db.prepare("UPDATE bonus SET used = used + 1 WHERE user_hash = ? AND task = ? AND used < granted RETURNING used")
        .bind(user, task).first();
      if (extra) {
        bonusTook = true;
        row = await db.prepare(
          "INSERT INTO usage (user_hash, month, task, units) VALUES (?, ?, ?, 1) " +
          "ON CONFLICT(user_hash, month, task) DO UPDATE SET units = units + 1 RETURNING units",
        ).bind(user, month, task).first();
      }
    }
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

  // was: const admitted = { month, used, limit, isNew, estimate: estimate > 0 ? estimate : 0, metered: false };
  // was: const admitted = { month, day: today, used, limit, isNew, estimate: estimate > 0 ? estimate : 0, metered: false };
  // `day` rides along with `month` so settle() and release() can correct the day's figure from the
  // same record; reading the clock again there would put the correction on the wrong day at midnight.
  // It starts null and is set only where the day's row is actually charged, below, so "the day was
  // charged" and "the day gets corrected" are one fact rather than two conditions kept in step.
  // was: const admitted = { month, day: null, used, limit, isNew, estimate: estimate > 0 ? estimate : 0, metered: false };
  // `bonusTook` says this run spent an invite unit, so release() gives that back rather than a month's
  // unit; `bonusLeft` is how many invite units remain, for the X-InternScout-Remaining header.
  const extraRow = limit > 0 ? await db.prepare("SELECT granted - used AS left FROM bonus WHERE user_hash = ? AND task = ?")
    .bind(user, task).first() : null;
  const admitted = { month, day: null, used, limit, isNew, estimate: estimate > 0 ? estimate : 0, metered: false,
                     bonusTook, bonusLeft: extraRow ? Math.max(0, extraRow.left) : 0 };
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
  // The day's share is the FREE tier's share of the month, not the whole deployment's (Bruce,
  // 2026-09-19). A Supporter or Pro student has already paid for their AI, and two things already
  // bound them: their own USER_BUDGET_CENTS row, charged just above, and the month's stop at the top
  // of this function. Neither moves when free accounts drain the day, and a day's share is 250c at
  // the $75 month -- about 41 auto-filled applications for the whole deployment -- while one Pro
  // plan sells 120 a month, so without this a paying student would meet "paused until tomorrow" on
  // a ceiling they did not drain and could not have. A paid call therefore neither reads nor writes
  // this row, and `admitted.day` stays null, which is what keeps release() and settle() off it too.
  // Charging it and checking it are one statement (addDaySpendUnder), so the burst that walked
  // through the old read-then-act can overshoot by at most the one estimate that crossed the line.
  if (plan === "free") {
    if (!(await addDaySpendUnder(db, today, admitted.estimate, dailyBudgetCents(env, config)))) {
      // Nothing reached the day's row, so nothing comes back from it. What does have to come back is
      // the account's own row, charged a few lines up when this account is metered, and the unit and
      // the call this run took. The month's figure is added below, so it has nothing to correct yet.
      if (admitted.metered && admitted.estimate > 0) {
        await db.prepare("UPDATE spend SET cents = MAX(0, cents - ?) WHERE user_hash = ? AND month = ?")
          .bind(admitted.estimate, user, month).run();
      }
      // release() deliberately keeps the rate counts, because its usual caller is a call that was
      // made. This one was not: it is refused here, before Gemini. So the buckets come back the same
      // way the global-busy branch above returns them, including the shared minute -- otherwise a
      // student retrying into a paused day would burn their own 300-a-day allowance on refusals and
      // eat GLOBAL_RPM slots that paying students, who are exempt from this stop, still need.
      await db.prepare("UPDATE rate SET calls = calls - 1 WHERE user_hash = ? AND bucket IN (?, ?) AND calls > 0")
        .bind(user, minute, dayBucket).run();
      await db.prepare("UPDATE rate SET calls = calls - 1 WHERE user_hash = ? AND bucket = ? AND calls > 0")
        .bind(GLOBAL_USER, minute).run();
      await release(db, user, task, runId, { ...admitted, estimate: 0 });
      const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      throw new HttpError(503, "paused",
                          "AI features are paused until tomorrow because today's share of the budget is used up. Search still works.",
                          { retry_after: Math.ceil((midnight - now.getTime()) / 1000) });
    }
    admitted.day = today;
  }
  await addSpend(db, month, admitted.estimate);
  // was: // Charged to the day as well as the month, so the ceiling above sees the estimate that has just
  // was: // been committed; settle() and release() correct both figures together.
  // was: await addDaySpend(db, today, admitted.estimate);
  return admitted;
}

// Units left for the task this month, for the X-InternScout-Remaining header: the month's own, plus
// any invite units, which are spent after them.
export function remainingOf(admitted) {
  if (admitted.limit == null) return "unlimited";
  // was: return Math.max(0, admitted.limit - admitted.used);
  return Math.max(0, admitted.limit - admitted.used) + (admitted.bonusLeft || 0);
}

// What /me reports as a task's limit, so that limit - used (the sum the dashboard and the extension
// already do) is what the student can still run: the month's allowance, or what they have used if
// invite units took them past it, plus the invite units left. An older client needs no change.
export const shownLimit = (limit, used, bonusLeft) => (limit == null ? null : Math.max(limit, used) + (bonusLeft || 0));

// Gemini refused or could not be reached: give back the unit, the call and the estimate. The rate
// buckets keep their count, since the call was made.
export async function release(db, user, task, runId, admitted) {
  // was: const { month, isNew, estimate, metered } = admitted;
  const { month, day, isNew, estimate, metered, bonusTook } = admitted;
  const stmts = [];
  if (isNew) {
    stmts.push(db.prepare("DELETE FROM runs WHERE user_hash = ? AND month = ? AND task = ? AND run_id = ?").bind(user, month, task, runId));
    stmts.push(db.prepare("UPDATE usage SET units = units - 1 WHERE user_hash = ? AND month = ? AND task = ? AND units > 0").bind(user, month, task));
    // The run was paid for with an invite unit (admit), so that is the one that comes back.
    if (bonusTook) stmts.push(db.prepare("UPDATE bonus SET used = used - 1 WHERE user_hash = ? AND task = ? AND used > 0").bind(user, task));
  } else {
    stmts.push(db.prepare("UPDATE runs SET calls = calls - 1 WHERE user_hash = ? AND month = ? AND task = ? AND run_id = ? AND calls > 0")
      .bind(user, month, task, runId));
  }
  if (estimate > 0) {
    stmts.push(db.prepare("UPDATE budget SET spend_cents = MAX(0, spend_cents - ?) WHERE month = ?").bind(estimate, month));
    // was: // The day's figure is deployment-wide like the month's, so it comes back whether or not this
    // was: // account is metered. Skipping it would let a run of Gemini failures pause AI for the rest of a
    // was: // day on calls that never cost anything.
    // was: stmts.push(db.prepare("UPDATE spend SET cents = MAX(0, cents - ?) WHERE user_hash = ? AND month = ?").bind(estimate, GLOBAL_USER, day));
    // `day` is set by admit() only where it charged the day's row, which it does only for a free
    // plan, so this gives back exactly what was taken and a paid call cannot drive the row below
    // what free accounts really spent. Where it is set the refund matters whether or not the account
    // is metered: without it a run of Gemini failures would pause AI for the rest of a day on calls
    // that never cost anything.
    if (day) {
      stmts.push(db.prepare("UPDATE spend SET cents = MAX(0, cents - ?) WHERE user_hash = ? AND month = ?").bind(estimate, GLOBAL_USER, day));
    }
    if (metered) stmts.push(db.prepare("UPDATE spend SET cents = MAX(0, cents - ?) WHERE user_hash = ? AND month = ?").bind(estimate, user, month));
  }
  await db.batch(stmts);
}

// Replaces the estimate charged at admission with what the call really cost, for the whole deployment
// and for the account, and adds the call's token counts to the month's totals (numbers only), so the
// share of input served from Gemini's cache can be read off one row.
export async function settle(db, user, admitted, cents, usage) {
  // was: const { month, estimate, metered } = admitted;
  const { month, day, estimate, metered } = admitted;
  const delta = (cents > 0 ? cents : 0) - estimate;
  const stmts = [];
  if (delta !== 0) {
    stmts.push(db.prepare(
      "INSERT INTO budget (month, spend_cents) VALUES (?, MAX(0, ?)) " +
      "ON CONFLICT(month) DO UPDATE SET spend_cents = MAX(0, spend_cents + ?)").bind(month, delta, delta));
    // was: // The same correction for the day, upserted rather than updated because an estimate of 0 leaves
    // was: // no row for the day to update. Without it the day's share would keep whatever the estimate
    // was: // guessed, which for a cheap call is several times what it really cost.
    // was: stmts.push(db.prepare(
    // was:   "INSERT INTO spend (user_hash, month, cents) VALUES (?, ?, MAX(0, ?)) " +
    // was:   "ON CONFLICT(user_hash, month) DO UPDATE SET cents = MAX(0, cents + ?)").bind(GLOBAL_USER, day, delta, delta));
    // The same correction for the day, and only where admit() charged it: `day` is the date for a
    // free plan and null for a paid one, so the correction mirrors the charge and a paid call cannot
    // drag the row below what free accounts really spent. Without this correction the day's share
    // would keep whatever the estimate guessed, which for a cheap call is several times its cost.
    // Left as an upsert rather than an update so a missing row is created rather than silently
    // dropped; after a free admission the row always exists, since the charge inserts it even for an
    // estimate of 0.
    if (day) {
      stmts.push(db.prepare(
        "INSERT INTO spend (user_hash, month, cents) VALUES (?, ?, MAX(0, ?)) " +
        "ON CONFLICT(user_hash, month) DO UPDATE SET cents = MAX(0, cents + ?)").bind(GLOBAL_USER, day, delta, delta));
    }
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
    ...forgetStatements(db, user),
  ]);
}

// was: // Daily cron: old rate buckets, last month's runs and per-account spend, usage older than a year.
// Daily cron: old rate buckets, last month's runs and per-account spend, usage older than a year. The
// `spend` sweep takes the day's-share rows with it, because a day in a past month sorts below that
// month's own key ("2026-09-14" < "2026-10"); today's row is longer than the current month's key and
// so is never swept out from under a live day.
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
