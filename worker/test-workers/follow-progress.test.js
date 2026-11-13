import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import {
  scopeLifetime,
  cleanupProgress,
  rollbackProgress,
  invalidProgress,
  boundedPayload,
  read,
  now,
} from "../test-support/follow-progress.js";

const equal = (actual, expected) => expect(actual).toEqual(expected);
const rejects = (fn) => expect(fn()).rejects.toThrow();
beforeEach(async () => {
  // Workers tests share their file's D1 storage; keep every scenario independent.
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("DELETE FROM follow_subscribers").run();
});
for (const scenario of [
  scopeLifetime,
  cleanupProgress,
  rollbackProgress,
  invalidProgress,
  boundedPayload,
]) {
  it(`local D1 follow progress: ${scenario.name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await scenario(env.DB, equal, rejects);
  });
}

it("migration backfills unique legacy identities once, leaves pending unset and rejects bad legacy timestamps", async () => {
  const db = env.DB;
  const name = "0009_follow_scope_progress.sql";
  // Recreate the exact pre-0009 migration state before seeding historical rows.
  await db.batch([
    db.prepare("DROP TABLE follow_scope_progress"),
    db.prepare("DELETE FROM d1_migrations WHERE name=?").bind(name),
  ]);
  await applyD1Migrations(
    db,
    env.TEST_MIGRATIONS.filter((m) => m.name !== name),
  );
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO follow_subscribers (id,email,created) VALUES (?,?,?)")
    .bind(id, "fixture@example.test", now.toISOString())
    .run();
  for (const [company, confirmed] of [
    ["alpha", now.toISOString()],
    ["beta", now.toISOString()],
    ["pending", null],
    ["bad", "invalid"],
  ]) {
    await db
      .prepare(
        "INSERT INTO follow_subscriptions (subscriber_id,scope_key,created,confirmed_at) VALUES (?,?,?,?)",
      )
      .bind(id, JSON.stringify({ kind: "company", company }), now.toISOString(), confirmed)
      .run();
  }
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  const rows = async () =>
    (await db.prepare("SELECT * FROM follow_scope_progress ORDER BY scope_key").all()).results;
  const first = await rows();
  expect(first).toHaveLength(3);
  expect(new Set(first.map((r) => r.scope_generation)).size).toBe(3);
  for (const row of first)
    expect(row.scope_generation).toMatch(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  await expect(read(db, id)).rejects.toThrow("Invalid follow progress");
  await db
    .prepare("DELETE FROM follow_subscriptions WHERE scope_key=?")
    .bind(JSON.stringify({ kind: "company", company: "bad" }))
    .run();
  expect(await read(db, id)).toHaveLength(2);
  const valid = await rows();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(await rows()).toEqual(valid);
  // Legacy bootstrap remains rerunnable as well, without resetting identity or watermark.
  await db.batch(env.TEST_SCHEMA_SQL.map((sql) => db.prepare(sql)));
  expect(await rows()).toEqual(valid);
});

it("legacy schema bootstrap supports the same confirmation lifetime and is rerunnable", async () => {
  const db = env.LEGACY_DB;
  await db.batch(env.TEST_SCHEMA_SQL.map((sql) => db.prepare(sql)));
  await scopeLifetime(db, equal);
  const before = (await db.prepare("SELECT * FROM follow_scope_progress").all()).results;
  await db.batch(env.TEST_SCHEMA_SQL.map((sql) => db.prepare(sql)));
  expect((await db.prepare("SELECT * FROM follow_scope_progress").all()).results).toEqual(before);
});
