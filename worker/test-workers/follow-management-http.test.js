import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, it, expect } from "vitest";
import { mintFollowToken } from "../src/follows.js";
import { cases, post, handler, fixture } from "../test-support/follow-management-http.js";
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("DELETE FROM follow_subscribers").run();
});
for (const [name, run] of cases) it(name, () => run(env.DB));
it("SQLite current UTC denies a capability that expires while the D1 operation is delayed", async () => {
  const { token, a, now } = await fixture(env.DB);
  await env.DB.prepare(
    "UPDATE follow_tokens SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+0.3 seconds') WHERE purpose='manage'",
  ).run();
  // Keep the original request time stale while the actual local database clock advances.
  const delayed = {
    prepare: (query) => env.DB.prepare(query),
    async batch(statements) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return env.DB.batch(statements);
    },
  };
  const http = handler(delayed, { now: () => now });
  expect((await http.list(post([token, null]))).status).toBe(410);
  expect(await (await handler(env.DB).remove(post([token, a.scopeKey]))).json()).toEqual({
    removed: false,
  });
  expect(await (await http.deleteAll(post([token]))).json()).toEqual({ deleted: false });
  expect(await env.DB.prepare("SELECT count(*) AS n FROM follow_subscriptions").first("n")).toBe(2);
});

it("selective removal keeps one admitted expiry snapshot across its entire delayed batch", async () => {
  const { token, a, now } = await fixture(env.DB);
  await mintFollowToken(env.DB, a.subscriberId, "confirm", { scopeKey: a.scopeKey }, now);
  let admitted;
  const delayed = {
    prepare: (query) => env.DB.prepare(query),
    async batch(statements) {
      // Native database wall clock crosses the capability cutoff after admission.
      await env.DB.prepare("UPDATE follow_tokens SET expires_at=? WHERE purpose='manage'")
        .bind(new Date(+admitted + 100).toISOString())
        .run();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(
        await env.DB.prepare(
          "SELECT count(*) AS n FROM follow_tokens WHERE purpose='manage' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        ).first("n"),
      ).toBe(0);
      return env.DB.batch(statements);
    },
  };
  const http = handler(delayed, { now: () => (admitted = new Date()) });
  expect(await (await http.remove(post([token, a.scopeKey]))).json()).toEqual({ removed: true });
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM follow_tokens WHERE purpose='confirm'").first(
      "n",
    ),
  ).toBe(0);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM follow_subscriptions").first("n")).toBe(1);
  expect(await (await handler(env.DB).remove(post([token, a.scopeKey]))).json()).toEqual({
    removed: false,
  });
});
