import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { it } from "vitest";
import * as scenarios from "../test-support/follow-subscriber-expiry-page.js";

// This maintenance entry also works with the currently deployed 0029 schema.
// Current ordered-schema cases run through the existing follow-retention suite.
for (const [name, scenario] of Object.entries(scenarios)) {
  it(`local D1 subscriber retention through 0029: ${name}`, async () => {
    await applyD1Migrations(
      env.MIGRATION_DB,
      env.TEST_MIGRATIONS.filter((m) => Number(m.name.slice(0, 4)) <= 29),
    );
    await env.MIGRATION_DB.batch(
      ["follow_subscribers", "follow_digest_days", "follow_send_budget"].map((table) =>
        env.MIGRATION_DB.prepare(`DELETE FROM ${table}`),
      ),
    );
    await scenario(env.MIGRATION_DB);
  });
}
