import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { it } from "vitest";
import * as scenarios from "../test-support/follow-delivery-tick.js";
for (const [name, scenario] of Object.entries(scenarios)) {
  it(`local D1 delivery tick: ${name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch(
      ["follow_subscribers", "follow_digest_days", "follow_send_budget"].map((table) =>
        env.DB.prepare(`DELETE FROM ${table}`),
      ),
    );
    await scenario(env.DB);
  });
}
