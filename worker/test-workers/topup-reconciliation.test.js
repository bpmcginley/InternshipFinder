import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { it } from "vitest";
import {
  reconciliationLifecycle,
  reconciliationRaces,
  reconciliationRollbackAndDeletion,
} from "../test-support/topup-reconciliation.js";

for (const scenario of [
  reconciliationLifecycle,
  reconciliationRaces,
  reconciliationRollbackAndDeletion,
]) {
  it(`local D1: ${scenario.name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await scenario(env.DB);
  });
}
