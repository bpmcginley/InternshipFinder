import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { it } from "vitest";
import * as scenarios from "../test-support/follow-signup-admission.js";

for (const [name, scenario] of Object.entries(scenarios))
  it(`local D1 signup admission: ${name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch(
      ["rate", "follow_subscribers"].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
    );
    await scenario(env.DB);
  });
