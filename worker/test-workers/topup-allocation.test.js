import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { it } from "vitest";
import {
  allocationLifecycle,
  allocationCurrentState,
  allocationRacesAndRollback,
} from "../test-support/topup-allocation.js";

for (const scenario of [allocationLifecycle, allocationCurrentState, allocationRacesAndRollback]) {
  it(`local D1: ${scenario.name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await scenario(env.DB);
  });
}
