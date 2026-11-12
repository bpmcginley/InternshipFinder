import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { handle } from "../src/index.js";
import { fixture, post } from "../test-support/follow-management-http.js";
import * as scenarios from "../test-support/follow-management-route.js";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch(
    ["follow_subscribers", "rate"].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
});
for (const [name, scenario] of Object.entries(scenarios)) it(name, () => scenario(env.DB));

it("mounted removal works with new requests off and retains its sibling scope", async () => {
  const { a, b, token } = await fixture(env.DB);
  const headers = { Origin: "https://internscout.org" };
  const binding = { DB: env.DB, FOLLOW_MANAGEMENT_ENABLED: "1" };
  const remove = await handle(
    post([token, a.scopeKey], headers, "https://api.example.test/follows/manage/remove"),
    binding,
  );
  expect(await remove.json()).toEqual({ removed: true });
  const list = await handle(
    post([token, null], headers, "https://api.example.test/follows/manage/list"),
    binding,
  );
  const page = await list.json();
  expect(page.scopes.map((scope) => scope.scope_key)).toEqual([b.scopeKey]);
});
