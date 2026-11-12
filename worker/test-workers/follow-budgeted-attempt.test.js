import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, it } from "vitest";
import * as scenarios from "../test-support/follow-budgeted-attempt.js";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM follow_subscribers"),
    env.DB.prepare("DELETE FROM follow_digest_days"),
    env.DB.prepare("DELETE FROM follow_send_budget"),
  ]);
});
for (const [name, scenario] of Object.entries(scenarios))
  it(`local D1 follow digest budget: ${name}`, () => scenario(env.DB));
