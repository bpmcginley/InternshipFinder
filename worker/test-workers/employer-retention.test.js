import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { it } from "vitest";
import * as scenarios from "../test-support/employer-retention.js";
for (const [name, scenario] of Object.entries(scenarios).sort(([a], [b]) => a.localeCompare(b))) {
  it(`local D1 employer retention: ${name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const result = await scenario(env.DB);
    if (result) console.log("Synthetic local D1 retention measurements", JSON.stringify(result));
  });
}
