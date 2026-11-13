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
  expect(await (await http.remove(post([token, a.scopeKey]))).json()).toEqual({
    removed: false,
  });
  expect(await (await http.deleteAll(post([token]))).json()).toEqual({ deleted: false });
  expect(await env.DB.prepare("SELECT count(*) AS n FROM follow_subscriptions").first("n")).toBe(2);
});

it("one SQL admission completes atomic removal even when a nested trigger crosses expiry", async () => {
  const { token, a, now } = await fixture(env.DB);
  await mintFollowToken(env.DB, a.subscriberId, "confirm", { scopeKey: a.scopeKey }, now);
  await env.DB.prepare(
    "CREATE TRIGGER fixture_slow_remove AFTER DELETE ON follow_tokens WHEN OLD.purpose='confirm' BEGIN SELECT sum(x) FROM (WITH RECURSIVE i(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM i WHERE x<5000000) SELECT x FROM i); END",
  ).run();
  let cutoff;
  const db = {
    prepare(query) {
      if (!query.startsWith("INSERT INTO follow_management_removals")) return env.DB.prepare(query);
      return {
        bind(...args) {
          return {
            async run() {
              const [, capture, result] = await env.DB.batch([
                env.DB.prepare(
                  "UPDATE follow_tokens SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+0.1 seconds') WHERE purpose='manage'",
                ),
                env.DB.prepare("SELECT expires_at FROM follow_tokens WHERE purpose='manage'"),
                env.DB.prepare(query).bind(...args),
              ]);
              cutoff = capture.results[0].expires_at;
              return result;
            },
          };
        },
      };
    },
  };
  try {
    expect(await (await handler(db).remove(post([token, a.scopeKey]))).json()).toEqual({
      removed: true,
    });
    const current = await env.DB.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at").first(
      "at",
    );
    expect(current >= cutoff).toBe(true);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM follow_tokens WHERE purpose='confirm'").first(
        "n",
      ),
    ).toBe(0);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM follow_subscriptions").first("n")).toBe(
      1,
    );
    expect(await (await handler(env.DB).remove(post([token, a.scopeKey]))).json()).toEqual({
      removed: false,
    });
  } finally {
    await env.DB.prepare("DROP TRIGGER fixture_slow_remove").run();
  }
}, 15000);

it("uncertain committed mutation receipts never report success or retry", async () => {
  for (const operation of ["remove", "deleteAll"])
    for (const fault of ["false", "string", "negative", "unsafe", "missing"]) {
      const { a, token } = await fixture(env.DB);
      let calls = 0;
      const db = {
        prepare(query) {
          return {
            bind(...args) {
              return {
                async run() {
                  calls++;
                  const result = await env.DB.prepare(query)
                    .bind(...args)
                    .run();
                  if (fault === "missing") return undefined;
                  if (fault === "false") result.success = false;
                  else
                    result.meta.changes = {
                      string: "1",
                      negative: -1,
                      unsafe: Number.MAX_SAFE_INTEGER + 1,
                    }[fault];
                  return result;
                },
              };
            },
          };
        },
      };
      const response = await handler(db)[operation](
        post(operation === "remove" ? [token, a.scopeKey] : [token]),
      );
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("");
      expect(calls).toBe(1);
      expect(
        await env.DB.prepare("SELECT count(*) AS n FROM follow_subscriptions WHERE subscriber_id=?")
          .bind(a.subscriberId)
          .first("n"),
      ).toBe(operation === "remove" ? 1 : 0);
    }
});
it("one-statement page uses the scoped index and rejects malformed authority/sentinel rows", async () => {
  const { token } = await fixture(env.DB);
  let query, args;
  const db = {
    prepare(sql) {
      query = sql;
      return {
        bind(...values) {
          args = values;
          return env.DB.prepare(sql).bind(...values);
        },
      };
    },
    batch: (statements) => env.DB.batch(statements),
  };
  expect((await handler(db).list(post([token, null]))).status).toBe(200);
  const plan = (
    await env.DB.prepare("EXPLAIN QUERY PLAN " + query)
      .bind(...args)
      .all()
  ).results;
  expect(plan.some((row) => /INDEX.*subscriber_id=.*scope_key>/.test(row.detail))).toBe(true);
  for (const row of [
    { subscriber_id: null },
    { present: 0, scope_key: null, created: null },
    { present: "1", scope_key: "x", created: "x", confirmed_at: null },
  ]) {
    const response = await handler({
      prepare: (sql) => env.DB.prepare(sql),
      async batch(statements) {
        expect(statements.length).toBe(1);
        const result = await env.DB.batch(statements);
        result[0].results = [row];
        return result;
      },
    }).list(post([token, null]));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
  }
});
