import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { it } from "vitest";
import * as scenarios from "../test-support/topup-session-reservation.js";
for (const scenario of Object.values(scenarios))
  it(`local D1: ${scenario.name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch(
      ["topup_checkout_attempts", "sessions", "session_copies", "forget"].map((table) =>
        env.DB.prepare(`DELETE FROM ${table}`),
      ),
    );
    await scenario(env.DB);
  });
