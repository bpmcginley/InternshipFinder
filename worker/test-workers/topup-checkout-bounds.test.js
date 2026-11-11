import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { it } from "vitest";
import { timeoutReservation } from "../test-support/topup-checkout-bounds.js";
for (const mode of ["fetch", "body", "revoked"])
  it(`local D1 checkout timeout and late response fence: ${mode}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.prepare("DELETE FROM topup_checkout_attempts").run();
    await timeoutReservation(env.DB, mode);
  });
