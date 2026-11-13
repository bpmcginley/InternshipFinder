import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import * as scenarios from "../test-support/follow-link-dispatch.js";
import { runFollowLinkDispatch } from "../src/follow-link-dispatch.js";
const reset = () =>
  env.DB.batch(
    ["follow_subscribers", "follow_send_budget", "rate"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
for (const [name, scenario] of Object.entries(scenarios))
  if (!["seed", "config"].includes(name))
    it(`native link dispatch: ${name}`, async () => {
      await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
      await reset();
      await scenario(env.DB);
    });
it("selection expiry advances only the candidate cursor without a claim", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await reset();
  const id = await scenarios.seed(env.DB, "management", 0, 1500);
  let batches = 0,
    sends = 0;
  const wrapped = {
    prepare: (sql) => env.DB.prepare(sql),
    batch: async (statements) => {
      const result = await env.DB.batch(statements);
      if (++batches === 2) {
        const expires = result[1].results[0].expires_at;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, Date.parse(expires) - Date.now()) + 25),
        );
      }
      return result;
    },
  };
  const result = await runFollowLinkDispatch(scenarios.config(wrapped, async () => sends++));
  expect(result.counts.skipped).toBe(1);
  expect(sends).toBe(0);
  expect(result.continuation.management.id).toBe(id);
  expect(
    await env.DB.prepare("SELECT claim_id FROM follow_management_outbox WHERE id=?")
      .bind(id)
      .first("claim_id"),
  ).toBeNull();
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM follow_send_budget").first("n")).toBe(0);
}, 10000);
