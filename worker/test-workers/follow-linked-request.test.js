import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { it } from "vitest";
import * as scenarios from "../test-support/follow-linked-request.js";
for (const [name, scenario] of Object.entries(scenarios))
  if (name !== "d1Reads")
    it(`local D1 scoped linking: ${name}`, async () => {
      await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
      await env.DB.batch(
        ["follow_subscribers", "sessions", "follow_send_budget"].map((t) =>
          env.DB.prepare(`DELETE FROM ${t}`),
        ),
      );
      await scenario(env.DB);
    });
