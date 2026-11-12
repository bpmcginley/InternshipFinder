import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { it } from "vitest";
import assert from "node:assert/strict";
import { expireFollowManagementRequests } from "../src/follow-retention.js";
import { seed } from "../test-support/follow-link-dispatch.js";
import * as scenarios from "../test-support/follow-delivery-owner.js";
for (const [name, scenario] of Object.entries(scenarios))
  it(`native Follow delivery owner: ${name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch(
      ["follow_subscribers", "follow_send_budget", "rate"].map((t) =>
        env.DB.prepare(`DELETE FROM ${t}`),
      ),
    );
    // Test fixture only. Runtime has deliberately no reset or initialization function.
    await env.DB.prepare(
      "INSERT OR REPLACE INTO follow_delivery_owner(singleton,version,generation,phase,next_kind) VALUES(1,1,lower(hex(randomblob(16))),'ready','confirmation')",
    ).run();
    await scenario(env.DB);
  });

it("native direct expiry count survives parallel unrelated writes", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("DELETE FROM follow_subscribers").run();
  for (let n = 0; n < 4; n++) await seed(env.DB, "management", n);
  await env.DB.prepare(
    "UPDATE follow_management_outbox SET queued_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'),expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')",
  ).run();
  const [result] = await Promise.all([
    expireFollowManagementRequests(env.DB, { enabled: true, maxRows: 1 }),
    env.DB.prepare("UPDATE follow_subscribers SET created=created").run(),
  ]);
  assert.deepEqual(result, { status: "maintained", removed: 1 });
  assert.equal(
    await env.DB.prepare("SELECT count(*) n FROM follow_management_outbox").first("n"),
    3,
  );
});
