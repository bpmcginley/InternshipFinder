import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import * as scenarios from "../test-support/follow-management-request.js";
import { enqueueFollowManagementRequest } from "../src/follow-management-request.js";

for (const [name, scenario] of Object.entries(scenarios))
  it(`native management request: ${name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch(
      ["follow_subscribers", "rate"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    );
    await scenario(env.DB);
  });

it("SQLite-expired requests are replaceable without a Worker clock", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch(["follow_subscribers", "rate"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(
    "INSERT INTO follow_subscribers VALUES('equality','equal@example.test','2026-01-01T00:00:00.000Z',NULL,NULL)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO follow_subscriptions VALUES('equality','scope','2026-01-01T00:00:00.000Z',NULL,NULL)",
  ).run();
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  await env.DB.prepare(
    `INSERT INTO follow_management_outbox(id,subscriber_id,queued_at,expires_at) VALUES('old','equality',strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second'),${now})`,
  ).run();
  expect(
    await enqueueFollowManagementRequest(
      env.DB,
      { email: "equal@example.test" },
      { enabled: true, ttlMs: 1000, dailyLimit: 50 },
    ),
  ).toEqual({ status: "accepted" });
  const row = await env.DB.prepare(
    "SELECT * FROM follow_management_outbox WHERE subscriber_id='equality'",
  ).first();
  expect(row.id).not.toBe("old");
  expect(Date.parse(row.expires_at) - Date.parse(row.queued_at)).toBe(1000);
});

it("missing migration fails closed after the rate attempt", async () => {
  await applyD1Migrations(
    env.DB,
    env.TEST_MIGRATIONS.filter((m) => m.name < "0026"),
  );
  // Native storage can persist between cases: explicitly establish the missing-table shape.
  await env.DB.prepare("DROP TABLE IF EXISTS follow_management_outbox").run();
  await env.DB.prepare("DELETE FROM rate").run();
  expect(
    await enqueueFollowManagementRequest(
      env.DB,
      { email: "unknown@example.test" },
      { enabled: true, ttlMs: 1000, dailyLimit: 1 },
    ),
  ).toEqual({ status: "unavailable" });
  expect(
    await env.DB.prepare("SELECT calls FROM rate WHERE user_hash='*follow-management'").first(
      "calls",
    ),
  ).toBe(1);
});
