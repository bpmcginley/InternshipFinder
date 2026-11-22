import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { it } from "vitest";
import * as scenarios from "../test-support/topup-history-observation.js";
for (const [name, scenario] of Object.entries(scenarios))
  it(`native history observation: ${name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch(
      [
        "topup_purchases",
        "topup_claims",
        "topup_checkout_attempts",
        "topup_history_receipts",
        "forget",
        "runs",
        "usage",
        "spend",
        "budget",
      ].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    );
    await scenario(env.DB);
  });
