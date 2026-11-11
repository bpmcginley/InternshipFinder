import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fakeD1 } from "./helpers.js";
import { readFollowProgress } from "../src/follow-progress.js";
import {
  scopeLifetime,
  cleanupProgress,
  rollbackProgress,
  invalidProgress,
  catalog,
  options,
} from "../test-support/follow-progress.js";

for (const scenario of [scopeLifetime, cleanupProgress, rollbackProgress, invalidProgress]) {
  test(`follow progress: ${scenario.name}`, () =>
    scenario(fakeD1(), assert.deepEqual, assert.rejects));
}

test("invalid progress read inputs fail before querying storage", async () => {
  const db = { prepare: () => assert.fail("unexpected storage read") };
  const id = crypto.randomUUID();
  for (const overrides of [
    { maxScopes: 0 },
    { maxScopes: Number.MAX_SAFE_INTEGER },
    { maxScopes: 1.1 },
    { maxBytes: 0 },
    { maxBytes: Infinity },
    { upperBound: "2026-11-10" },
  ]) {
    await assert.rejects(
      () => readFollowProgress(db, id, catalog, { ...options, ...overrides }),
      /Invalid follow progress/,
    );
  }
  await assert.rejects(
    () => readFollowProgress(db, "fixture@example.test", catalog, options),
    /Invalid follow progress/,
  );
});

test("oversized or noncanonical legacy scopes reject without returning a valid prefix", async () => {
  const db = fakeD1(),
    id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO follow_subscribers (id,email,created) VALUES (?,?,?)")
    .bind(id, "fixture@example.test", options.upperBound)
    .run();
  for (const key of ['{"company":"alpha","kind":"company"}', "x".repeat(5000)]) {
    await db
      .prepare(
        "INSERT INTO follow_subscriptions (subscriber_id,scope_key,created,confirmed_at) VALUES (?,?,?,?)",
      )
      .bind(id, key, options.upperBound, options.upperBound)
      .run();
    await db
      .prepare("INSERT INTO follow_scope_progress VALUES (?,?,?,?)")
      .bind(id, key, crypto.randomUUID(), options.upperBound)
      .run();
    await assert.rejects(
      () => readFollowProgress(db, id, catalog, options),
      /Invalid follow progress/,
    );
    await db.prepare("DELETE FROM follow_subscriptions").run();
  }
});

test("migration is mirrored, scope progress remains unwired and reader cannot select email", () => {
  const read = (path) =>
    readFileSync(new URL(path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  assert.ok(read("../schema.sql").includes(read("../migrations/0009_follow_scope_progress.sql")));
  assert.doesNotMatch(read("../src/index.js"), /follow-progress/);
  assert.doesNotMatch(read("../src/follow-progress.js"), /SELECT[^;]*\bemail\b/);
});
