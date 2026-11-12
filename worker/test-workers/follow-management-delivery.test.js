import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import * as scenarios from "../test-support/follow-management-delivery.js";
import { deliverFollowManagement } from "../src/follow-management-delivery.js";
for (const [name, scenario] of Object.entries(scenarios))
  if (!["seed", "config", "presentation", "buildLinks"].includes(name))
    it(`native management delivery: ${name}`, async () => {
      await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
      await env.DB.batch(
        ["follow_subscribers", "follow_send_budget", "rate"].map((t) =>
          env.DB.prepare(`DELETE FROM ${t}`),
        ),
      );
      await scenario(env.DB);
    });
it("real DB queue expiry between claim and final fence prevents the handoff", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch(
    ["follow_subscribers", "follow_send_budget", "rate"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  const jobId = await scenarios.seed(env.DB, 1500);
  let calls = 0,
    sends = 0;
  const wrapped = {
    prepare: (s) => env.DB.prepare(s),
    batch: async (statements) => {
      const r = await env.DB.batch(statements);
      if (++calls === 4) {
        expect(r[1].meta.changes).toBe(1);
        const expiry = await env.DB.prepare(
          "SELECT expires_at FROM follow_management_outbox WHERE id=?",
        )
          .bind(jobId)
          .first("expires_at");
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, Date.parse(expiry) - Date.now()) + 25),
        );
      }
      return r;
    },
  };
  expect(
    await deliverFollowManagement({
      ...scenarios.config(wrapped),
      jobId,
      transport: async () => sends++,
    }),
  ).toEqual({ status: "unavailable" });
  expect(calls).toBe(5);
  expect(sends).toBe(0);
  expect(await env.DB.prepare("SELECT attempts FROM follow_send_budget").first("attempts")).toBe(1);
}, 10000);
