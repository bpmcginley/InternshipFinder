import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

const scopeCount = 183;
const prior = "2026-11-01T00:00:00.000Z";
const through = "2026-11-01T00:00:01.000Z";
const created = "2026-11-01T00:00:02.000Z";
const expires = "2026-11-02T00:00:00.000Z";

async function fixture(db, variant) {
  await db
    .prepare(
      "INSERT INTO follow_subscribers(id,email,created) VALUES('fixture','digest@example.test',?)",
    )
    .bind(prior)
    .run();
  await db
    .prepare(
      "INSERT INTO follow_digest_outbox VALUES('digest','fixture','2026-11-01','[]',?,?,'attempting','lease',?,?,NULL)",
    )
    .bind(created, expires, expires, created)
    .run();

  const advances = [];
  const rows = [];
  const expected = [];
  for (let index = 0; index < scopeCount; index++) {
    const scope = index.toString(36);
    const generation = `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`;
    advances.push({ scopeKey: scope, generation, confirmedAt: prior, from: prior, to: through });
    if (variant === "changed" && index === 0) continue;
    const confirmed = variant === "changed" && index === 1 ? through : prior;
    const current = variant === "changed" && index === 2 ? "a".repeat(36) : generation;
    const watermark = variant === "changed" && index === 3 ? created : prior;
    expected.push([
      scope,
      variant === "duplicate" || (variant === "changed" && index < 4) ? watermark : through,
    ]);
    rows.push(
      db
        .prepare("INSERT INTO follow_subscriptions VALUES('fixture',?,?,?,NULL)")
        .bind(scope, prior, confirmed),
      db
        .prepare("INSERT INTO follow_scope_progress VALUES('fixture',?,?,?)")
        .bind(scope, current, watermark),
    );
  }
  await db.batch(rows);
  if (variant === "duplicate") advances[0] = advances[1];
  const payload = JSON.stringify(advances).padEnd(32768, " ");
  expect(new TextEncoder().encode(payload)).toHaveLength(32768);
  await db
    .prepare("INSERT INTO follow_pending_progress VALUES('digest',?,?,?)")
    .bind("1".repeat(64), through, payload)
    .run();
  return expected;
}

async function complete(db, state) {
  return db
    .prepare(
      "UPDATE follow_digest_outbox SET state=?,payload=NULL,lease_token=NULL,lease_until=NULL WHERE id='digest'",
    )
    .bind(state)
    .run();
}

async function verify(db, expected, state) {
  const result = await db.prepare("SELECT scope_key,watermark FROM follow_scope_progress").all();
  expect(result.results.map(({ scope_key, watermark }) => [scope_key, watermark]).sort()).toEqual(
    expected.sort(),
  );
  expect(await db.prepare("SELECT count(*) FROM follow_pending_progress").first()).toEqual({
    "count(*)": 0,
  });
  expect(
    await db
      .prepare("SELECT state,payload,lease_token,lease_until FROM follow_digest_outbox")
      .first(),
  ).toEqual({
    state,
    payload: null,
    lease_token: null,
    lease_until: null,
  });
}

it("0032 replaces the existing trigger and bounds reads with unrelated pending jobs", async () => {
  const latest = env.TEST_MIGRATIONS.find(({ name }) => name.startsWith("0032_"));
  expect(latest).toBeDefined();
  await applyD1Migrations(
    env.DB,
    env.TEST_MIGRATIONS.filter((migration) => migration !== latest),
  );
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO follow_subscribers(id,email,created) VALUES('other','other@example.test',?)",
    ).bind(prior),
    env.DB.prepare(
      "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<2000) " +
        "INSERT INTO follow_digest_outbox SELECT 'other-'||i,'other',i,'[]',?,?,'queued',NULL,NULL,NULL,NULL FROM n",
    ).bind(created, expires),
    env.DB.prepare(
      "INSERT INTO follow_pending_progress SELECT id,?,?,? FROM follow_digest_outbox WHERE subscriber_id='other'",
    ).bind("2".repeat(64), through, "[1]"),
  ]);
  const expected = await fixture(env.DB, "valid");
  const extraScopes =
    "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<2000) ";
  await env.DB.batch([
    env.DB.prepare(
      extraScopes + "INSERT INTO follow_subscriptions SELECT 'fixture','extra-'||i,?,?,NULL FROM n",
    ).bind(prior, prior),
    env.DB.prepare(
      extraScopes +
        "INSERT INTO follow_scope_progress SELECT 'fixture','extra-'||i,'unrelated-'||i,? FROM n",
    ).bind(prior),
  ]);
  await applyD1Migrations(env.DB, [latest]);
  const result = await complete(env.DB, "uncertain");
  expect(result.meta.rows_read).toBeLessThan(10000);
  // State changes also maintain the expiry index introduced in 0033.
  expect(result.meta.rows_written).toBeLessThanOrEqual(scopeCount + 4);
  expect(
    await env.DB.prepare("SELECT count(*) AS total FROM follow_pending_progress").first("total"),
  ).toBe(2000);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS total FROM follow_digest_outbox WHERE subscriber_id='other' AND state='queued'",
    ).first("total"),
  ).toBe(2000);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS total FROM follow_scope_progress WHERE subscriber_id='fixture' AND watermark=?",
    )
      .bind(through)
      .first("total"),
  ).toBe(expected.length);
});

it.each([
  ["uncertain", "valid"],
  ["accepted", "changed"],
  ["uncertain", "duplicate"],
])("Follow %s finalization preserves existing rules for %s progress", async (state, variant) => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("DELETE FROM follow_subscribers").run();
  const expected = await fixture(env.DB, variant);
  const result = await complete(env.DB, state);
  expect(result.success).toBe(true);
  expect(result.meta.rows_read).toBeLessThan(10000);
  expect(result.meta.rows_written).toBeLessThanOrEqual(scopeCount + 4);
  await verify(env.DB, expected, state);
});

it("uses the same bounded finalizer in a fresh legacy schema", async () => {
  await env.LEGACY_DB.batch(env.TEST_SCHEMA_SQL.map((sql) => env.LEGACY_DB.prepare(sql)));
  const expected = await fixture(env.LEGACY_DB, "valid");
  const result = await complete(env.LEGACY_DB, "accepted");
  expect(result.success).toBe(true);
  expect(result.meta.rows_read).toBeLessThan(10000);
  await verify(env.LEGACY_DB, expected, "accepted");
});
