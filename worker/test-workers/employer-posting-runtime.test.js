import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { it } from "vitest";
import * as scenarios from "../test-support/employer-posting-runtime.js";
for (const [name, scenario] of Object.entries(scenarios))
  it(`local employer route: ${name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await scenario(env.DB);
  });
