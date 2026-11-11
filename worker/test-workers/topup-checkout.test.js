import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { it } from "vitest";
import {
  checkoutReservation,
  checkoutAmbiguity,
  checkoutAssociation,
  checkoutAtomicity,
} from "../test-support/topup-checkout.js";
for (const scenario of [
  checkoutReservation,
  checkoutAmbiguity,
  checkoutAssociation,
  checkoutAtomicity,
])
  it(scenario.name, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.prepare("DELETE FROM topup_checkout_attempts").run();
    await scenario(env.DB);
  });
