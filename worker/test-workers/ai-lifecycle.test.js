import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { it } from "vitest";
import * as scenarios from "../test-support/ai-lifecycle.js";
for (const scenario of Object.values(scenarios))
  it(`local D1 route: ${scenario.name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await scenario(env.DB);
  });
it("default legacy /ai works on baseline 0001 without funded tables", async () => {
  await applyD1Migrations(
    env.LEGACY_DB,
    env.TEST_MIGRATIONS.filter((m) => m.name === "0001_baseline.sql"),
  );
  await scenarios.aiLegacyDoesNotReadFundedSchema(env.LEGACY_DB);
});
