import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { claimFollowManagementRequest } from "../src/follow-management-claim.js";
import * as scenarios from "../test-support/follow-management-claim.js";
for (const [name, scenario] of Object.entries(scenarios))
  it(`native management claim: ${name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch(
      ["follow_subscribers", "follow_send_budget", "rate"].map((t) =>
        env.DB.prepare(`DELETE FROM ${t}`),
      ),
    );
    await scenario(env.DB);
  });

it("actual SQLite expiry after job read denies issuance and preserves the old token", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch(
    ["follow_subscribers", "follow_send_budget", "rate"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  await scenarios.atomicIssuanceReplacesOnlyManagementAndReplaysNoCredit(env.DB);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "UPDATE follow_management_outbox SET id=?,claim_id=NULL,queued_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1.5 seconds')",
  )
    .bind(id)
    .run();
  const oldTokens = (await env.DB.prepare("SELECT * FROM follow_tokens ORDER BY token_hash").all())
    .results;
  let reads = 0;
  const wrapped = {
    prepare: (sql) => env.DB.prepare(sql),
    batch: async (statements) => {
      const receipts = await env.DB.batch(statements);
      if (++reads === 1) {
        expect(receipts[0].results).toHaveLength(1);
        const expiry = Date.parse(receipts[0].results[0].expires_at);
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiry - Date.now()) + 25));
      }
      return receipts;
    },
  };
  expect(await claimFollowManagementRequest(wrapped, id, { enabled: true, cap: 5 })).toEqual({
    status: "unavailable",
  });
  expect(
    (await env.DB.prepare("SELECT * FROM follow_tokens ORDER BY token_hash").all()).results,
  ).toEqual(oldTokens);
  expect(
    await env.DB.prepare("SELECT claim_id FROM follow_management_outbox WHERE id=?")
      .bind(id)
      .first("claim_id"),
  ).toBeNull();
  expect(await env.DB.prepare("SELECT attempts FROM follow_send_budget").first("attempts")).toBe(1);
}, 10000);
