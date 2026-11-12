import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { it } from "vitest";
import * as scenarios from "../test-support/topup-webhook.js";
for (const [name, scenario] of Object.entries(scenarios))
  it(name, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await scenario(env.DB);
  });
