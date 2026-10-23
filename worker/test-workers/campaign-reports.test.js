// 2026-10-23: verify queue SQL, month privacy and concurrent leases in actual local D1/workerd.
// No provider bindings, live DB, checkout, or actual mail are used.
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { expireCampaignReportMail, processCampaignReports } from "../src/campaign-reports.js";

beforeAll(async () => {
  await env.DB.batch(env.TEST_SCHEMA_SQL.map(s => env.DB.prepare(s)));
});

it("D1 waits for whole closed months, leases concurrent senders, freezes snapshots and erases delivered PII", async () => {
  const at = "2026-11-01T00:00:00.000Z";
  const order = "runtime-report-order", placement = "runtime-report-placement", listing = "abcdef1234567890";
  await env.DB.prepare("INSERT INTO employer_orders (id, created, updated, status, package, start_day, employer_key, employer, " +
    "company, name, email, email_domain, terms_version, terms_at, price) VALUES (?, ?, ?, 'approved', 'one', " +
    "'2026-09-01', 'acme & partners', 'Acme', 'Acme', 'Private contact', 'hiring@employer.example', 'employer.example', '2026-10-19', ?, 2900)")
    .bind(order, at, at, at).run();
  await env.DB.prepare("INSERT INTO placements (id, employer, listing_id, apply_url, start_day, end_day, status, ended_reason, " +
    "created, created_by, updated, updated_by) VALUES (?, 'Acme', ?, 'https://employer.example/apply', '2026-09-23', '2026-10-23', " +
    "'ended', 'dates', ?, 'test', ?, 'test')").bind(placement, listing, at, at).run();
  await env.DB.prepare("INSERT INTO employer_order_roles (order_id, listing_id, employer_key, company, title, apply_url, placement_id) " +
    "VALUES (?, ?, 'acme & partners', 'Acme', 'Engineering Intern', 'https://employer.example/apply', ?)").bind(order, listing, placement).run();
  await env.DB.prepare("INSERT INTO placement_log (placement, at, by, action, reason, before, after) VALUES (?, ?, 'cron', 'cron_end', 'dates', ?, ?)")
    .bind(placement, at, JSON.stringify({ status: "on", start_day: "2026-09-23", end_day: "2026-10-23" }),
      JSON.stringify({ status: "ended", ended_reason: "dates", start_day: "2026-09-23", end_day: "2026-10-23" })).run();
  for (const [day, n] of [["2026-09", 100], ["2026-09-23", 25], ["2026-10-30", 17], ["2026-11-01", 900]]) {
    await env.DB.prepare("INSERT INTO placement_counts (day, placement, page, event, n) VALUES (?, ?, 'dashboard', 'shown', ?)")
      .bind(day, placement, n).run();
  }
  const sent = [], local = { ORDER_FROM: "InternScout <listings@internscout.example>", EMAIL: { send: async m => sent.push(m) } };
  await processCampaignReports(env.DB, local, new Date("2026-10-31T23:59:59.000Z"));
  expect(await env.DB.prepare("SELECT * FROM employer_campaign_reports WHERE placement_id = ?").bind(placement).first()).toBeNull();
  await processCampaignReports(env.DB, { ...local, EMAIL: undefined }, new Date(at));
  let row = await env.DB.prepare("SELECT * FROM employer_campaign_reports WHERE placement_id = ?").bind(placement).first();
  expect(row.attempts).toBe(0);
  expect(row.body).toContain("shows: 140+");
  expect(row.body).toContain("2026-09-01 through 2026-10-31");
  expect(row.body).toContain("?company=acme%20%26%20partners");
  const body = row.body;
  await env.DB.prepare("UPDATE placement_counts SET n = n + 500 WHERE day = '2026-09'").run();
  await Promise.all([processCampaignReports(env.DB, local, new Date(at)), processCampaignReports(env.DB, local, new Date(at))]);
  expect(sent).toHaveLength(1); expect(sent[0].text).toBe(body);
  row = await env.DB.prepare("SELECT * FROM employer_campaign_reports WHERE placement_id = ?").bind(placement).first();
  expect(row.state).toBe("sent"); expect(row.attempts).toBe(1);
  for (const key of ["to_address", "body", "subject", "reply_to", "lease_token", "sending_until"]) expect(row[key]).toBeNull();
});

it("D1 expiry clears pending payload even without sending mail", async () => {
  await env.DB.prepare("INSERT INTO employer_campaign_reports (placement_id, order_id, start_day, end_day, created, state, to_address, body, subject) " +
    "VALUES ('runtime-expired-report', 'runtime-old-order', '2026-09-01', '2026-10-01', '2026-10-01T00:00:00.000Z', 'queued', " +
    "'hiring@employer.example', 'private payload', 'results')").run();
  await expireCampaignReportMail(env.DB, new Date("2026-10-31T00:00:00.000Z"));
  const row = await env.DB.prepare("SELECT * FROM employer_campaign_reports WHERE placement_id = 'runtime-expired-report'").first();
  expect(row.state).toBe("skipped"); expect(row.skipped_reason).toBe("queue_expired");
  expect(row.to_address).toBeNull(); expect(row.body).toBeNull(); expect(row.subject).toBeNull();
});
