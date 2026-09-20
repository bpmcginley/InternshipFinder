// The day's share of the budget: who it applies to, and that charging it cannot be raced.
// These call admit(), release() and settle() directly rather than going through /ai, because what
// is being checked is which rows one admission writes and which it must leave alone. The /ai-level
// behaviour of the day's stop (the 503, /me and /config agreeing with it, the refund on a Gemini
// failure, settling to the real cost) is covered in ai.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { NOW, fakeD1, makeEnv } from "./helpers.js";
import { CONFIG } from "../src/config.js";
import { GLOBAL_USER, addDaySpendUnder, admit, release, settle } from "../src/limits.js";

const DAY = "2026-09-14";        // NOW is 2026-09-14T10:05:30Z
const MONTH = "2026-09";
const dayCents = async (db) =>
  (await db.prepare("SELECT cents FROM spend WHERE user_hash = ? AND month = ?").bind(GLOBAL_USER, DAY).first())?.cents ?? 0;
const accountCents = (db) =>
  db.dump().spend.filter((r) => r.user_hash !== GLOBAL_USER).reduce((s, r) => s + r.cents, 0);
const ask = (db, env, user, plan, run, estimate = 6) =>
  admit(db, env, CONFIG, user, "field_match", run, NOW, "edu", plan, estimate);

// Bruce, 2026-09-19: the day row is the free tier's share of the month, not the whole deployment's.
// A Supporter or Pro student has paid for their AI and is bounded by their own USER_BUDGET_CENTS row
// and by the monthly stop, so a ceiling free accounts drained must never answer them "paused until
// tomorrow": at $12 a month that is a refund request, not a degraded free tier.
test("the day's share stops a free student and lets a paying one through", async () => {
  const db = fakeD1();
  const env = makeEnv({ DAILY_BUDGET_CENTS: "10" });
  await db.prepare("INSERT INTO spend (user_hash, month, cents) VALUES (?, ?, 10)").bind(GLOBAL_USER, DAY).run();

  await assert.rejects(
    () => ask(db, env, "free-user", "free", "r-free"),
    (e) => e.status === 503 && e.code === "paused" && /tomorrow/.test(e.message) && e.extra.retry_after > 0,
  );
  // A refused admission leaves nothing behind: not the day's row, not the unit, not the run, and not
  // the account's own ceiling row, which is charged a few lines before the day's is.
  assert.equal(await dayCents(db), 10, "a refused call must not be charged to the day");
  assert.equal(db.dump().usage.reduce((s, r) => s + r.units, 0), 0, "the unit came back");
  assert.equal(db.dump().runs.length, 0, "the run came back");
  assert.equal(accountCents(db), 0, "the account's own ceiling row came back");
  assert.equal(db.dump().budget.length, 0, "the month is nowhere near spent");

  for (const plan of ["supporter", "pro"]) {
    // Admitted, although the day's row is over the free ceiling and stays there.
    const a = await ask(db, env, plan + "-a", plan, "r-" + plan + "-a");
    assert.equal(a.day, null, "a paid call does not ride on the day's row");
    assert.equal(await dayCents(db), 10, "and does not add to it");

    // release() and settle() have to mirror that exactly. If either corrected the day's row for a
    // call that never charged it, every paid call would drag it below what free accounts spent, and
    // the free tier's day would quietly grow with paid traffic.
    await settle(db, plan + "-a", a, 12, null);
    assert.equal(await dayCents(db), 10, "settle() leaves a paid call's day alone");

    const b = await ask(db, env, plan + "-b", plan, "r-" + plan + "-b");
    await release(db, plan + "-b", "field_match", "r-" + plan + "-b", b);
    assert.equal(await dayCents(db), 10, "release() leaves a paid call's day alone");
  }
});

// The old shape read daySpend() at the top of admit() and wrote it seven D1 round trips later, so a
// burst all read the same figure and all passed. The charge is now one conditional statement, so the
// check and the write cannot be separated and the overshoot is bounded by the estimate that crossed.
test("the day's charge refuses the write once the row is at the ceiling", async () => {
  const db = fakeD1();
  // Eight at once, 6c each against a 10c day. The first two find the row under the ceiling; the rest
  // are refused by the statement itself, not by anything the caller read beforehand.
  const burst = await Promise.all(
    Array.from({ length: 8 }, () => addDaySpendUnder(db, DAY, 6, 10)),
  );
  assert.deepEqual(burst.filter(Boolean).length, 2, "a read-then-act would have let all eight through");
  assert.equal(await dayCents(db), 12, "one estimate of overshoot, not eight");

  // At or past the ceiling nothing is written at all, so a refusal has nothing to give back.
  assert.equal(await addDaySpendUnder(db, DAY, 6, 12), false);
  assert.equal(await addDaySpendUnder(db, DAY, 6, 10), false);
  assert.equal(await dayCents(db), 12);
  // A ceiling of 0 is "no AI today" and has to refuse even on a day with no row yet, which the bare
  // INSERT would not: inserting 0 cents into an empty day counts as a change.
  assert.equal(await addDaySpendUnder(db, "2026-09-15", 6, 0), false);
  assert.equal(db.dump().spend.filter((r) => r.month === "2026-09-15").length, 0);
});

// The same property one level up: two admissions racing for the last of the day's share.
test("two admissions racing for the last of the day's share: one is charged, one is paused", async () => {
  const db = fakeD1();
  const env = makeEnv({ DAILY_BUDGET_CENTS: "10" });
  await db.prepare("INSERT INTO spend (user_hash, month, cents) VALUES (?, ?, 9)").bind(GLOBAL_USER, DAY).run();

  const race = await Promise.allSettled([
    ask(db, env, "racer-a", "free", "run-a"),
    ask(db, env, "racer-b", "free", "run-b"),
  ]);
  const passed = race.filter((r) => r.status === "fulfilled");
  const paused = race.filter((r) => r.status === "rejected");
  assert.equal(passed.length, 1, "9c of a 10c day leaves room for one estimate, not two");
  assert.equal(paused.length, 1);
  assert.equal(paused[0].reason.status, 503);
  assert.equal(paused[0].reason.code, "paused");
  assert.equal(passed[0].value.day, DAY, "a free call that was charged carries the date");
  assert.equal(await dayCents(db), 15, "one estimate of overshoot, not two");

  // The refusal unwound: only the admitted call holds a unit, a run and an account charge.
  assert.equal(accountCents(db), 6);
  assert.equal(db.dump().usage.reduce((s, r) => s + r.units, 0), 1);
  assert.equal(db.dump().runs.length, 1);
});
