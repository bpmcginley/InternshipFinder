// Server transitions and aggregate cash use actual local SQLite, no payment or email providers.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeD1, setup } from "./helpers.js";
import { employerMetrics } from "../src/employer-metrics.js";
import { run } from "../scripts/placement.mjs";

const NOW = new Date("2026-10-23T20:00:00Z");
async function create(db, n, { key = "example", pilot = null, at = "2026-10-21T12:00:00Z" } = {}) {
  const id = "o-" + String(n).padStart(16, "0");
  await db.prepare("INSERT INTO employer_orders (id,created,updated,status,package,start_day,employer_key,employer,company,name,email,email_domain,terms_version,terms_at,price,pilot_code) " +
    "VALUES (?,?,?,'unverified','one','2026-11-01',?,'Example','Private company','Private buyer','private@example.invalid','example.invalid','2026-10-19',?,2900,?)")
    .bind(id, at, at, key, at, pilot).run();
  return id;
}
async function paid(db, id, amount = 2900, at = "2026-10-21T13:00:00Z") {
  await db.prepare("UPDATE employer_orders SET status='verified',verified_at=? WHERE id=? AND status='unverified'").bind(at, id).run();
  await db.prepare("UPDATE employer_orders SET status='paid',paid_at=?,paid_amount=? WHERE id=? AND status='verified'").bind(at, amount, id).run();
}
const counts = async (db) => Object.fromEntries((await db.prepare("SELECT event,SUM(n) AS n FROM event_counts GROUP BY event").all()).results.map(r => [r.event, r.n]));

test("atomic transitions count real payment once, separate pilots/comps and recognize returning employer keys", async () => {
  const db = fakeD1();
  const first = await create(db, 1);
  await paid(db, first);
  await paid(db, first); // The paid CAS rejects a replay even when a status write is repeated.
  // Normal production retries don't change status back; directly attempt the real paid CAS again.
  await db.prepare("UPDATE employer_orders SET status='paid' WHERE id=? AND status='verified'").bind(first).run();
  const pilot = await create(db, 2, { pilot: "PILOT-TEST" }); await paid(db, pilot, 0);
  const comp = await create(db, 3); await paid(db, comp, 0);
  const repeat = await create(db, 4); await paid(db, repeat, 2900, "2026-10-22T10:00:00Z");
  assert.deepEqual(await counts(db), { employer_order_created: 4, employer_email_verified: 4,
    employer_paid: 2, employer_pilot: 1, employer_comped: 1, employer_repeat_paid: 1 });
  const stored = JSON.stringify((await db.prepare("SELECT * FROM event_counts").all()).results);
  assert.doesNotMatch(stored, /private|example|o-000/);
  const before = await counts(db);
  await db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  assert.deepEqual(await counts(db), before, "a second schema deploy never backfills or recounts orders");
  await db.prepare("DELETE FROM employer_orders WHERE id=?").bind(first).run();
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM employer_funnel_marks WHERE order_id=?").bind(first).first("n"), 0);
  assert.deepEqual(await counts(db), before, "aggregate history survives contact-record deletion");
});

test("rolled-back orders and transitions leave no analytics side effects", async () => {
  const db = fakeD1();
  const id = await create(db, 8);
  await assert.rejects(db.batch([
    db.prepare("UPDATE employer_orders SET status='verified',verified_at=? WHERE id=?").bind(NOW.toISOString(), id),
    db.prepare("INSERT INTO employer_orders (id) VALUES (?)").bind("invalid"),
  ]));
  assert.equal((await counts(db)).employer_email_verified, undefined);
  assert.equal(await db.prepare("SELECT status FROM employer_orders WHERE id=?").bind(id).first("status"), "unverified");
});

test("cash cohort includes refusal and early-close refunds, credits and pending obligations without claiming profit", async () => {
  const db = fakeD1();
  const id = await create(db, 1); await paid(db, id);
  const refused = await create(db, 2, { key: "another" }); await paid(db, refused);
  await db.prepare("UPDATE employer_orders SET status='refused',refunded_amount=2900 WHERE id=?").bind(refused).run();
  for (const [n, status, amount, refund] of [[1,"refund",1000,"re_test"],[2,"credit",200,null],[3,"offered",300,null]]) {
    await db.prepare("INSERT INTO employer_credits (id,order_id,placement_id,created,updated,amount,unused_days,token_hash,status,refund_id) " +
      "VALUES (?,?,?,?,?,?,1,'not-a-secret',?,?)").bind("credit"+n,id,"placement"+n,NOW.toISOString(),NOW.toISOString(),amount,status,refund).run();
  }
  const today = await create(db, 3, { at: NOW.toISOString() }); await paid(db, today, 2900, NOW.toISOString());
  const report = await employerMetrics(db, 7, NOW);
  assert.equal(report.start,"2026-10-16"); assert.equal(report.end_exclusive,"2026-10-23");
  assert.deepEqual(report.cash_cohort, { orders: 2,collected_cents:5800,refunded_cents:3900,
    issued_credit_cents:200,pending_compensation_cents:300,disputed_original_cents:0,
    collected_less_recorded_refunds_cents:1900 });
  assert.match(report.about,/not.*profit/); assert.doesNotMatch(JSON.stringify(report),/private@|Private buyer|Private company/);
  for (const days of [0,91,1.5,NaN]) await assert.rejects(employerMetrics(db,days,NOW),/days must/);
});

test("metrics are terminal-admin only, no-store, and available from the read-only script", async () => {
  const w = await setup({env:{ADMIN_TOKEN:"synthetic-admin"}});
  assert.equal((await w.api("GET","/admin/employer-metrics")).status,401);
  assert.equal((await w.api("GET","/admin/employer-metrics",{token:"synthetic-admin",headers:{Origin:"https://internscout.org"}})).status,403);
  const response = await w.api("GET","/admin/employer-metrics",{token:"synthetic-admin"});
  assert.equal(response.status,200); assert.equal(response.headers.get("Cache-Control"),"no-store");
  const calls=[];
  assert.equal(await run(["metrics"],{env:{INTERNSCOUT_ADMIN_TOKEN:"synthetic-admin"},
    fetch:async(url,init)=>{calls.push([url,init]);return Response.json({events:[]});},out:()=>{},err:()=>{}}),0);
  assert.match(calls[0][0],/\/admin\/employer-metrics$/); assert.equal(calls[0][1].method,"GET");
});
