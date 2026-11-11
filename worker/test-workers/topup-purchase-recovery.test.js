import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { it } from "vitest";
import * as scenarios from "../test-support/topup-purchase-recovery.js";
for (const scenario of Object.values(scenarios))
  it(`local D1: ${scenario.name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await scenario(env.DB);
  });
