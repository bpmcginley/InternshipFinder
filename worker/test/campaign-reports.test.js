// 2026-10-23: real in-memory SQLite exercises the outbox SQL without any provider or live DB.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fakeD1 } from "./helpers.js";
import { COUNT_DAYS, rollupPlacementCounts } from "../src/placements.js";
import { CAMPAIGN_REPORT_ATTEMPTS, CAMPAIGN_REPORT_BATCH, campaignReportMail,
  expireCampaignReportMail, processCampaignReports } from "../src/campaign-reports.js";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const DAY_MS = 86400_000;
const day = (d) => d.toISOString().slice(0, 10);
const shifted = (d, n) => day(new Date(Date.parse(d + "T00:00:00Z") + n * DAY_MS));

async function world({ seed = true, ...over } = {}) {
  const db = fakeD1();
  await db.exec(readFileSync(new URL("../campaign-report-schema.sql", import.meta.url), "utf8"));
  const sent = [];
  const email = { failures: 0, send: async (mail) => {
    if (email.failures-- > 0) throw Object.assign(new Error("test provider outage"), { code: "E_TEST" });
    sent.push(mail); return { messageId: "local-test" };
  } };
  const env = { EMAIL: email, ORDER_FROM: "InternScout <listings@internscout.example>", REVIEW_TO: "listings@internscout.example" };
  const w = { db, sent, email, env, serial: 0 };
  if (seed) Object.assign(w, await campaign(w, over));
  return w;
}

async function campaign(w, { status = "approved", placementStatus = "ended", reason = "dates", start = "2026-09-23",
  end = "2026-10-23", disputed = null, naturalLog = true, beforeStatus = "on", pause = false } = {}) {
  const n = ++w.serial;
  const order = "o-" + n.toString(16).padStart(16, "0"), listing = n.toString(16).padStart(16, "0"), placement = `p-test-${n}`;
  await w.db.prepare("INSERT INTO employer_orders (id, created, updated, status, package, start_day, employer_key, employer, " +
    "company, name, email, email_domain, terms_version, terms_at, price, disputed_at) VALUES (?, ?, ?, ?, 'one', " +
    "'2026-09-01', 'acme', 'Acme', 'Acme', 'Private Hiring Contact', 'hiring@employer.example', 'employer.example', " +
    "'2026-10-19', ?, 2900, ?)").bind(order, NOW.toISOString(), NOW.toISOString(), status, NOW.toISOString(), disputed).run();
  await w.db.prepare("INSERT INTO placements (id, employer, listing_id, apply_url, start_day, end_day, status, ended_reason, " +
    "created, created_by, updated, updated_by) VALUES (?, 'Acme', ?, 'https://employer.example/apply', ?, ?, ?, ?, ?, 'test', ?, 'test')")
    .bind(placement, listing, start, end, placementStatus, reason, NOW.toISOString(), NOW.toISOString()).run();
  await w.db.prepare("INSERT INTO employer_order_roles (order_id, listing_id, employer_key, company, title, apply_url, placement_id) " +
    "VALUES (?, ?, 'acme', 'Acme', 'Engineering Intern', 'https://employer.example/apply', ?)").bind(order, listing, placement).run();
  if (naturalLog) await w.db.prepare("INSERT INTO placement_log (placement, at, by, action, reason, before, after) " +
    "VALUES (?, ?, 'cron', 'cron_end', 'dates', ?, ?)").bind(placement, NOW.toISOString(),
      JSON.stringify({ status: beforeStatus, start_day: start, end_day: end }),
      JSON.stringify({ status: "ended", ended_reason: "dates", start_day: start, end_day: end })).run();
  if (pause) await w.db.prepare("INSERT INTO placement_log (placement, at, by, action, reason) VALUES (?, ?, 'test', 'pause', 'manual')")
    .bind(placement, NOW.toISOString()).run();
  return { order, placement, listing };
}

const queue = (w) => w.db.prepare("SELECT * FROM employer_campaign_reports ORDER BY placement_id").all().then(r => r.results);
const count = (w, date, event, n, page = "dashboard") => w.db.prepare(
  "INSERT INTO placement_counts (day, placement, page, event, n) VALUES (?, ?, ?, ?, ?)")
  .bind(date, w.placement, page, event, n).run();
function erased(row) {
  for (const k of ["to_address", "subject", "body", "reply_to", "sending_until", "lease_token", "next_attempt_at"]) assert.equal(row[k], null, k);
}

test("standalone report migration matches the integrated production schema", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../campaign-report-schema.sql", import.meta.url), "utf8"));
  const integrated = fakeD1();
  for (const pragma of ["table_info(employer_campaign_reports)", "index_list(employer_campaign_reports)"]) {
    const standalone = db.prepare("PRAGMA " + pragma).all().map(r => ({ ...r }));
    const { results } = await integrated.prepare("PRAGMA " + pragma).all();
    assert.deepEqual(results, standalone);
  }
  db.close();
});

test("natural approved campaign reports its actual window and whole ended months once", async () => {
  const w = await world();
  await count(w, "2026-08-31", "shown", 900);
  await count(w, "2026-09-22", "shown", 10);
  await count(w, "2026-09-23", "shown", 17); await count(w, "2026-09-23", "open", 12);
  await count(w, "2026-09-29", "shown", 28, "landing"); await count(w, "2026-09-29", "open", 13, "landing");
  await count(w, "2026-10-22", "shown", 9); await count(w, "2026-10-22", "open", 1);
  await count(w, "2026-11-01", "shown", 500);
  assert.deepEqual(await processCampaignReports(w.db, w.env, NOW), { queued: 1, attempted: 1, sent: 1, skipped: 0 });
  const text = w.sent[0].text;
  assert.match(text, /2026-09-23 through 2026-10-22, inclusive/);
  assert.match(text, /2026-10-23 at 00:00 UTC and is not included/);
  assert.doesNotMatch(text, /Private Hiring Contact/);
  assert.match(text, /Report period \(UTC\): 2026-09-01 through 2026-10-31, inclusive, covering whole calendar months/);
  assert.match(text, /Report generated: 2026-11-01T12:00:00.000Z/);
  assert.match(text, /snapshot recorded at generation/);
  assert.match(text, /including days outside the campaign window/);
  assert.match(text, /shows: 60\+/); assert.match(text, /opens: 20\+/);
  assert.match(text, /repeat events|automated traffic/); assert.match(text, /cannot say how many people applied/);
  assert.match(text, /not a guarantee that the box was served every day/);
  assert.match(text, /https:\/\/internscout.org\/employers\/buy\/\?company=acme/);
  assert.match(text, /Nothing renews automatically/);
  const [row] = await queue(w); assert.equal(row.state, "sent"); assert.equal(row.attempts, 1); erased(row);
  assert.deepEqual(await processCampaignReports(w.db, w.env, NOW), { queued: 0, attempted: 0, sent: 0, skipped: 0 });
  assert.equal(w.sent.length, 1);
});

for (const [name, over] of [
  ["unapproved", { status: "paid" }], ["refused", { status: "refused" }],
  ["disputed", { disputed: NOW.toISOString() }], ["still running", { placementStatus: "on" }],
  ["paused", { placementStatus: "paused" }], ["future end", { end: "2026-11-02" }],
  ["closed early", { reason: "role_closed" }], ["refunded", { reason: "refunded" }],
]) test(`${name} campaigns do not enter the automatic results queue`, async () => {
  const w = await world(over); await processCampaignReports(w.db, w.env, NOW);
  assert.equal(w.sent.length, 0); assert.equal((await queue(w)).length, 0);
});

for (const [name, over, reason] of [
  ["past manual pause", { pause: true }, "interrupted"],
  ["cron ended from paused", { beforeStatus: "paused" }, "completion_unverified"],
  ["manual end without cron evidence", { naturalLog: false }, "completion_unverified"],
  ["more than 62 days", { start: "2026-08-01" }, "invalid_window"],
]) test(`${name} is skipped without an optimistic delivery claim`, async () => {
  const w = await world(over); await processCampaignReports(w.db, w.env, NOW);
  const [row] = await queue(w); assert.equal(row.state, "skipped"); assert.equal(row.skipped_reason, reason); erased(row);
  assert.equal(w.sent.length, 0);
});

test("manual end action using dates never passes for a natural completed campaign", async () => {
  const w = await world();
  await w.db.prepare("INSERT INTO placement_log (placement, at, by, action, reason) VALUES (?, ?, 'test', 'end', 'dates')")
    .bind(w.placement, NOW.toISOString()).run();
  await processCampaignReports(w.db, w.env, NOW);
  assert.equal((await queue(w))[0].skipped_reason, "interrupted"); assert.equal(w.sent.length, 0);
});

test("zero recorded events use the privacy threshold, never an application or exposure promise", async () => {
  const w = await world(); await processCampaignReports(w.db, w.env, NOW);
  assert.match(w.sent[0].text, /shows: fewer than 10/); assert.match(w.sent[0].text, /opens: fewer than 10/);
});

test("current-month campaigns wait without a tombstone and become eligible next month", async () => {
  const w = await world();
  assert.deepEqual(await processCampaignReports(w.db, w.env, new Date("2026-10-31T23:59:59Z")),
    { queued: 0, attempted: 0, sent: 0, skipped: 0 });
  assert.equal((await queue(w)).length, 0);
  await processCampaignReports(w.db, w.env, new Date("2026-11-01T00:00:00Z"));
  assert.equal(w.sent.length, 1);
});

test("an exclusive first-of-month end can report immediately without including the new month", async () => {
  const w = await world({ start: "2026-10-01", end: "2026-11-01" });
  await count(w, "2026-10-31", "shown", 28); await count(w, "2026-11-01", "shown", 900);
  await processCampaignReports(w.db, w.env, NOW);
  assert.match(w.sent[0].text, /Report period \(UTC\): 2026-10-01 through 2026-10-31/);
  assert.match(w.sent[0].text, /shows: 20\+/);
});

test("whole-month totals preserve rolled-up and remaining daily counts at the 400-day boundary", async () => {
  const cutoff = day(new Date(NOW.getTime() - COUNT_DAYS * DAY_MS));
  const old = await world({ start: shifted(cutoff, -1), end: shifted(cutoff, 29) });
  await count(old, shifted(cutoff, -1), "shown", 25); await count(old, cutoff, "shown", 39);
  await rollupPlacementCounts(old.db, NOW);
  const { results: granularity } = await old.db.prepare("SELECT day FROM placement_counts").all();
  assert.ok(granularity.some(r => r.day.length === 7)); assert.ok(granularity.some(r => r.day.length === 10));
  await processCampaignReports(old.db, old.env, NOW); assert.match(old.sent[0].text, /shows: 60\+/);
  const mixed = await world(); await count(mixed, "2026-09", "shown", 100); await count(mixed, "2026-09-23", "shown", 25);
  await processCampaignReports(mixed.db, mixed.env, NOW);
  assert.match(mixed.sent[0].text, /shows: 120\+/);
});

for (const n of [-1, Number.MAX_SAFE_INTEGER + 1]) test(`invalid event count ${n} cannot become a misleading report`, async () => {
  const w = await world(); await count(w, "2026-09-23", "shown", n);
  await processCampaignReports(w.db, w.env, NOW);
  assert.equal((await queue(w))[0].skipped_reason, "counts_invalid"); assert.equal(w.sent.length, 0);
});

test("provider failure keeps the exact report, waits for backoff, and clears PII after retry", async () => {
  const w = await world(); w.email.failures = 1;
  await count(w, "2026-09-23", "shown", 47);
  await processCampaignReports(w.db, w.env, NOW);
  let [row] = await queue(w); const original = row.body;
  assert.equal(row.state, "queued"); assert.equal(row.attempts, 1); assert.match(original, /shows: 40\+/);
  assert.deepEqual(await processCampaignReports(w.db, w.env, NOW), { queued: 0, attempted: 0, sent: 0, skipped: 0 });
  await processCampaignReports(w.db, w.env, new Date(NOW.getTime() + 15 * 60_000));
  [row] = await queue(w); assert.equal(row.state, "sent"); assert.equal(row.attempts, 2); erased(row);
  assert.equal(w.sent[0].text, original);
});

test("disabled email does not burn attempts; concurrent cron calls deliver one claimed message", async () => {
  const w = await world(); const env = { ...w.env, EMAIL: undefined };
  await processCampaignReports(w.db, env, NOW);
  assert.equal((await queue(w))[0].attempts, 0);
  await Promise.all([processCampaignReports(w.db, w.env, NOW), processCampaignReports(w.db, w.env, NOW)]);
  assert.equal(w.sent.length, 1); assert.equal((await queue(w))[0].attempts, 1);
});

test("an interrupted sender's lease expires and is recovered", async () => {
  const w = await world(); await processCampaignReports(w.db, { ...w.env, EMAIL: undefined }, NOW);
  const expires = new Date(NOW.getTime() + 5 * 60_000);
  await w.db.prepare("UPDATE employer_campaign_reports SET sending_until = ?, lease_token = 'crashed', attempts = 1")
    .bind(expires.toISOString()).run();
  await processCampaignReports(w.db, w.env, NOW); assert.equal(w.sent.length, 0);
  await processCampaignReports(w.db, w.env, expires); assert.equal(w.sent.length, 1);
  erased((await queue(w))[0]);
});

test("a dispute arriving just after the lease is claimed is rechecked before provider access", async () => {
  const w = await world(); const originalPrepare = w.db.prepare.bind(w.db);
  w.db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (!sql.startsWith("UPDATE employer_campaign_reports SET sending_until = ?")) return statement;
    return { bind: (...params) => {
      const bound = statement.bind(...params);
      return { ...bound, run: async () => {
        const result = await bound.run();
        await originalPrepare("UPDATE employer_orders SET disputed_at = ? WHERE id = ?").bind(NOW.toISOString(), w.order).run();
        return result;
      } };
    } };
  };
  await processCampaignReports(w.db, w.env, NOW);
  assert.equal(w.sent.length, 0); const [row] = await queue(w); assert.equal(row.skipped_reason, "order_ineligible"); erased(row);
});

test("changed placement dates or a removed order contact cancel a queued report and erase PII", async () => {
  for (const mutation of ["dates", "contact"]) {
    const w = await world(); await processCampaignReports(w.db, { ...w.env, EMAIL: undefined }, NOW);
    if (mutation === "dates") await w.db.prepare("UPDATE placements SET end_day = '2026-10-22' WHERE id = ?").bind(w.placement).run();
    else await w.db.prepare("UPDATE employer_orders SET email = '' WHERE id = ?").bind(w.order).run();
    await processCampaignReports(w.db, w.env, NOW);
    assert.equal(w.sent.length, 0); const [row] = await queue(w); assert.equal(row.state, "skipped"); erased(row);
  }
});

test("thirty-day expiry and exhausted/crashed retry budgets erase PII but keep idempotency", async () => {
  const w = await world(); await processCampaignReports(w.db, { ...w.env, EMAIL: undefined }, NOW);
  const later = new Date(NOW.getTime() + 30 * DAY_MS);
  assert.equal(await expireCampaignReportMail(w.db, later), 1);
  let [row] = await queue(w); assert.equal(row.skipped_reason, "queue_expired"); erased(row);
  await processCampaignReports(w.db, w.env, later); assert.equal(w.sent.length, 0);
  const exhausted = await world(); await processCampaignReports(exhausted.db, { ...exhausted.env, EMAIL: undefined }, NOW);
  await exhausted.db.prepare("UPDATE employer_campaign_reports SET attempts = ?, sending_until = ?")
    .bind(CAMPAIGN_REPORT_ATTEMPTS, NOW.toISOString()).run();
  await processCampaignReports(exhausted.db, exhausted.env, NOW);
  [row] = await queue(exhausted); assert.equal(row.skipped_reason, "delivery_attempts_exhausted"); erased(row);
});

test("a failed final delivery attempt terminates instead of retaining contact data", async () => {
  const w = await world(); await processCampaignReports(w.db, { ...w.env, EMAIL: undefined }, NOW);
  await w.db.prepare("UPDATE employer_campaign_reports SET attempts = ?").bind(CAMPAIGN_REPORT_ATTEMPTS - 1).run();
  w.email.failures = 1; await processCampaignReports(w.db, w.env, NOW);
  const [row] = await queue(w); assert.equal(row.skipped_reason, "delivery_attempts_exhausted"); erased(row);
});

test("new queues and due delivery work each respect the bounded batch per call", async () => {
  const w = await world({ seed: false });
  for (let n = 0; n < CAMPAIGN_REPORT_BATCH + 1; n++) await campaign(w);
  const disabled = { ...w.env, EMAIL: undefined };
  const first = await processCampaignReports(w.db, disabled, NOW); assert.equal(first.queued, CAMPAIGN_REPORT_BATCH);
  assert.equal((await queue(w)).length, CAMPAIGN_REPORT_BATCH);
  assert.equal((await processCampaignReports(w.db, disabled, NOW)).queued, 1);
  assert.equal((await processCampaignReports(w.db, w.env, NOW)).sent, CAMPAIGN_REPORT_BATCH);
  assert.equal(w.sent.length, CAMPAIGN_REPORT_BATCH);
});

test("a full batch of new queues plus a separate full delivery batch stays below the D1 query budget", async () => {
  const w = await world({ seed: false });
  for (let n = 0; n < CAMPAIGN_REPORT_BATCH; n++) await campaign(w);
  await processCampaignReports(w.db, { ...w.env, EMAIL: undefined }, NOW);
  for (let n = 0; n < CAMPAIGN_REPORT_BATCH; n++) await campaign(w);
  let queries = 0;
  const counted = {
    prepare(sql) {
      const wrap = statement => ({
        bind: (...params) => wrap(statement.bind(...params)),
        first: async (...args) => { queries++; return statement.first(...args); },
        all: async (...args) => { queries++; return statement.all(...args); },
        run: async (...args) => { queries++; return statement.run(...args); },
      });
      return wrap(w.db.prepare(sql));
    },
    exec: async (...args) => { queries++; return w.db.exec(...args); },
    batch: async (...args) => { queries++; return w.db.batch(...args); },
  };
  const result = await processCampaignReports(counted, w.env, NOW);
  assert.equal(result.queued, CAMPAIGN_REPORT_BATCH);
  assert.equal(result.sent, CAMPAIGN_REPORT_BATCH);
  assert.equal(queries, 33, "record the measured full-path SQL calls so new queries need a budget review");
  assert.ok(queries <= 40, `${queries} D1 queries exceed the reserved budget`);
  assert.ok(queries + w.sent.length <= 40, "reserve headroom for provider requests and cron expiry");
});

test("renewal is intentional, uses only a public employer key, and has a safe fallback", () => {
  const row = { title: "Intern\nBcc: other", company: "Acme", email: "hiring@employer.example", start_day: "2026-09-23",
    end_day: "2026-10-23", employer_key: "bad\nkey" };
  const mail = campaignReportMail(row, { shown: "10+", opened: "fewer than 10" }, {}, NOW);
  assert.match(mail.text, /https:\/\/internscout.org\/employers\/buy\/\n/);
  assert.doesNotMatch(mail.text, /secret|\nBcc:/); assert.equal(mail.replyTo, undefined);
  const real = campaignReportMail({ ...row, employer_key: "acme & partners" }, { shown: "10+", opened: "fewer than 10" }, {}, NOW);
  assert.match(real.text, /buy\/\?company=acme%20%26%20partners/);
});
