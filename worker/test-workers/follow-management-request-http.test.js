import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { it } from "vitest";
import * as scenarios from "../test-support/follow-management-request-http.js";
for (const [name, scenario] of Object.entries(scenarios))
  it(`native management request HTTP: ${name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch(
      ["follow_subscribers", "rate"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    );
    await scenario(env.DB);
  });
