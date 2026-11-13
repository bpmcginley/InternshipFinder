// 2026-10-23: delivery switches and reconciliation errors must never suspend queued-contact expiry.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { CAMPAIGN_REPORT_CRON } from "../src/campaign-reports.js";
import { makeEnv } from "./helpers.js";

for (const failedReconciliation of [false, true]) {
  test(`daily cron erases expired campaign mail with delivery off, reconciliation failure=${failedReconciliation}`, async () => {
    const env = makeEnv({ EMPLOYER_REPORTS: "0" });
    const old = new Date(Date.now() - 31 * 86400e3).toISOString();
    await env.DB.prepare("INSERT INTO employer_campaign_reports (placement_id,order_id,start_day,end_day,created,state,to_address,subject,body) " +
      "VALUES ('expired-report','synthetic-order','2026-08-01','2026-08-31',?,'queued','test@example.invalid','Private','Private body')")
      .bind(old).run();
    if (failedReconciliation) {
      const prepare = env.DB.prepare.bind(env.DB);
      env.DB.prepare = (sql) => {
        if (sql.startsWith("UPDATE pilot_codes SET order_id = NULL, used_at = NULL WHERE order_id IN ")) {
          throw new Error("Synthetic reconciliation outage");
        }
        return prepare(sql);
      };
    }
    const pending = [];
    worker.scheduled({ cron: "17 7 * * *" }, env, { waitUntil: p => pending.push(p) });
    const finished = await Promise.allSettled(pending);
    assert.equal(finished.some(r => r.status === "rejected"), failedReconciliation);
    const row = await env.DB.prepare("SELECT * FROM employer_campaign_reports WHERE placement_id='expired-report'").first();
    assert.equal(row.state, "skipped"); assert.equal(row.skipped_reason, "queue_expired");
    for (const key of ["to_address","subject","body","reply_to","sending_until","lease_token","next_attempt_at"]) assert.equal(row[key], null);
  });
}

test("report cron has an isolated invocation and delivery flag never pauses expiry", async () => {
  const config = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.ok(config.includes('"' + CAMPAIGN_REPORT_CRON + '"'), "configured cron matches router");
  for (const enabled of ["0", "1"]) {
    const env = makeEnv({ EMPLOYER_REPORTS: enabled });
    const queries = [], prepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = sql => { queries.push(sql); return prepare(sql); };
    const pending = [];
    worker.scheduled({ cron: CAMPAIGN_REPORT_CRON }, env, { waitUntil: p => pending.push(p) });
    await Promise.all(pending);
    assert.ok(queries.some(sql => sql.startsWith("UPDATE employer_campaign_reports SET state = 'skipped'")));
    assert.equal(queries.some(sql => sql.includes("FROM placements p JOIN employer_order_roles")), enabled === "1");
    assert.ok(!queries.some(sql => sql.includes("DELETE FROM employer_orders") || sql.includes("UPDATE pilot_codes")),
      "report budget is separate from the financial cleanup invocation");
  }
});
