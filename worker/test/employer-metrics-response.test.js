import test from "node:test";
import assert from "node:assert/strict";
import { employerMetrics } from "../src/employer-metrics.js";
import { employerMetricsResponse } from "../src/employer-metrics-response.js";
import { fakeD1, setup } from "./helpers.js";

const now = new Date("2026-11-11T12:00:00Z");
const enabled = { EMPLOYER_POSTING_COUNTS_ENABLED: "1" };
const read = (db, env, query) =>
  employerMetricsResponse({
    db,
    env,
    now,
    request: new Request(`https://worker.test/admin/employer-metrics?${query}`),
  });
const withCursor = (after) => new URLSearchParams({ days: "1", organic_after: after });

test("employer response defaults to the existing no-store funnel", async () => {
  const db = fakeD1();
  const baseline = await employerMetrics(db, 28, now);
  // Disabled reports do not even prepare the optional storage query.
  await db.exec("DROP TABLE employer_posting_counts");
  for (const env of [{}, { EMPLOYER_POSTING_COUNTS_ENABLED: true }]) {
    const response = await read(db, env, "organic_after=ignored");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), baseline);
  }
  const failed = await (await read(db, enabled, "")).json();
  assert.deepEqual(failed, { ...baseline, organic_posting_counts: { status: "unavailable" } });
});

test("employer response pages only completed company totals and preserves funnel fields", async () => {
  const db = fakeD1();
  await db.exec(
    "WITH RECURSIVE seq(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM seq WHERE x < 1000) " +
      "INSERT INTO employer_posting_counts SELECT '2026-11-10',printf('key-%04d',x),1 FROM seq;" +
      "INSERT INTO employer_posting_counts VALUES ('2026-11-09','older',1),('2026-11-11','current',1);" +
      "INSERT INTO employer_posting_day_caps VALUES ('2026-11-11',200);",
  );
  const baseline = await employerMetrics(db, 1, now);
  const response = await read(db, enabled, "days=1");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const { organic_posting_counts: page, ...funnel } = await response.json();
  assert.deepEqual(funnel, baseline);
  assert.equal(page.status, "available");
  assert.equal(page.start, "2026-11-10");
  assert.equal(page.end_exclusive, "2026-11-11");
  assert.equal(page.rows.length, 1000);
  assert.deepEqual(page.rows[0], { day: "2026-11-10", company: "key-0000", n: 1 });
  assert.equal(page.next.company, "key-0999");

  const last = await (await read(db, enabled, withCursor(JSON.stringify(page.next)))).json();
  assert.deepEqual(last.organic_posting_counts.rows, [
    { day: "2026-11-10", company: "key-1000", n: 1 },
  ]);
  assert.equal(last.organic_posting_counts.next, null);
});

test("employer response rejects oversized, repeated, malformed and stale cursors", async () => {
  const db = fakeD1();
  const cursor = {
    start: "2026-11-09",
    end_exclusive: "2026-11-10",
    day: "2026-11-09",
    company: "key",
  };
  const repeated = withCursor(JSON.stringify(cursor));
  repeated.append("organic_after", JSON.stringify(cursor));
  for (const query of [
    withCursor(""),
    withCursor("é".repeat(513)),
    withCursor("{}"),
    withCursor(JSON.stringify(cursor)),
    repeated,
  ]) {
    await assert.rejects(read(db, enabled, query), { status: 400, code: "organic_after" });
  }
  await assert.rejects(read(db, enabled, "days=91"), { status: 400, code: "days" });
});

test("the existing owner-only route still returns only the funnel", async () => {
  const env = { ...enabled, ADMIN_TOKEN: "synthetic-admin" };
  const w = await setup({ env });
  assert.equal((await w.api("GET", "/admin/employer-metrics")).status, 401);
  const response = await w.api("GET", "/admin/employer-metrics", { token: env.ADMIN_TOKEN });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(Object.hasOwn(await response.json(), "organic_posting_counts"), false);
});
