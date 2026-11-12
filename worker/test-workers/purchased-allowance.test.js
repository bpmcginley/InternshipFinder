import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { it } from "vitest";
import { purchasedAllowanceProjection } from "../test-support/purchased-allowance.js";

it("local D1: signed-in purchased allowance projection", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await purchasedAllowanceProjection(env.DB);
});
