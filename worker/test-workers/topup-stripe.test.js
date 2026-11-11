import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { it } from "vitest";
import { stripeReservationRoundTrip } from "../test-support/topup-stripe.js";
it("mocked Stripe reservation and ephemeral retrieval on local D1", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("DELETE FROM topup_checkout_attempts").run();
  await stripeReservationRoundTrip(env.DB);
});
