import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { it } from "vitest";
import * as scenarios from "../test-support/topup-history-coverage.js";
for (const [name, scenario] of Object.entries(scenarios))
  it(`native history coverage: ${name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch(
      ["topup_history_coverage", "forget"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    );
    await scenario(env.DB);
  });
