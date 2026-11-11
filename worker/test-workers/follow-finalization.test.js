import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import * as scenarios from "../test-support/follow-finalization.js";
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("DELETE FROM follow_subscribers").run();
  await env.DB.prepare("DELETE FROM follow_digest_days").run();
});
for (const [name, scenario] of Object.entries(scenarios))
  it(`local D1 follow finalization: ${name}`, () =>
    scenario(
      env.DB,
      (a, b) => expect(a).toEqual(b),
      (fn) => expect(fn()).rejects.toThrow(),
    ));
