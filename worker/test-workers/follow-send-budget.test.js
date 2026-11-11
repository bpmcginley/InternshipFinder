import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, it } from "vitest";
import * as scenarios from "../test-support/follow-send-budget.js";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("DELETE FROM follow_send_budget").run();
});
for (const [name, scenario] of Object.entries(scenarios)) {
  it(`local D1 follow send budget: ${name}`, () => scenario(env.DB));
}
