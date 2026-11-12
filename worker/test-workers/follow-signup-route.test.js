import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { it } from "vitest";
import * as scenarios from "../test-support/follow-signup-route.js";

for (const [name, scenario] of Object.entries(scenarios))
  it(`native D1 follow signup route: ${name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch(
      ["follow_subscribers", "rate", "sessions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    );
    await scenario(env.DB);
  });
