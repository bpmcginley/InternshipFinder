import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { it } from "vitest";
import * as cases from "../test-support/follow-prepared-related.js";
for (const [name, scenario] of Object.entries(cases))
  it(name, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch(
      ["follow_subscribers", "follow_digest_days", "follow_send_budget"].map((table) =>
        env.DB.prepare(`DELETE FROM ${table}`),
      ),
    );
    await scenario(env.DB);
  });
