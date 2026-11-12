import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { it } from "vitest";
import * as scenarios from "../test-support/follow-owned-digest-runtime.js";
for (const [name, scenario] of Object.entries(scenarios))
  it(`native owned digest: ${name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch(
      ["follow_subscribers", "follow_send_budget", "follow_digest_days", "rate"].map((t) =>
        env.DB.prepare(`DELETE FROM ${t}`),
      ),
    );
    // Test fixture only. Runtime has deliberately no reset or initialization function.
    await env.DB.prepare(
      "INSERT OR REPLACE INTO follow_delivery_owner(singleton,version,generation,phase,next_kind) VALUES(1,1,lower(hex(randomblob(16))),'ready','confirmation')",
    ).run();
    await scenario(env.DB);
  });
