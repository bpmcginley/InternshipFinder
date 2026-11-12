import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { it } from "vitest";
import * as scenarios from "../test-support/topup-checkout-expiry.js";
for (const scenario of Object.values(scenarios))
  it(`local D1: ${scenario.name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch(
      ["topup_purchases", "topup_claims", "topup_checkout_attempts"].map((table) =>
        env.DB.prepare(`DELETE FROM ${table}`),
      ),
    );
    await scenario(env.DB);
  });
