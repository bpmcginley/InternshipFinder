import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { it } from "vitest";
import * as scenarios from "../test-support/topup-checkout-route.js";

for (const [name, scenario] of Object.entries(scenarios)) {
  it(`local D1 checkout route: ${name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch(
      ["topup_checkout_attempts", "session_copies", "sessions"].map((table) =>
        env.DB.prepare("DELETE FROM " + table),
      ),
    );
    await scenario(env.DB);
  });
}
