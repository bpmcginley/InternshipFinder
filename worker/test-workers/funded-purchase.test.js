import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { it } from "vitest";
import assert from "node:assert/strict";
import * as scenarios from "../test-support/funded-purchase.js";
for (const scenario of Object.values(scenarios))
  it(`local D1: ${scenario.name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch(
      [
        "runs",
        "topup_purchases",
        "topup_claims",
        "usage",
        "bonus",
        "budget",
        "spend",
        "forget",
        "event_counts",
        "tokens",
        "task_tokens",
      ].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    );
    await scenario(env.DB);
  });
it("0018 preserves populated 0017 metadata, calls and legacy purchase receipts", async () => {
  const db = env.MIGRATION_DB;
  await applyD1Migrations(
    db,
    env.TEST_MIGRATIONS.filter((m) => !m.name.startsWith("0018")),
  );
  const user = "a".repeat(64),
    payment = "b".repeat(64),
    checkout = "c".repeat(64),
    generation = crypto.randomUUID(),
    call = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO runs VALUES(?,'2026-11','autofill','existing',2)").bind(user),
    db
      .prepare(
        "INSERT INTO funded_runs VALUES(?,'2026-11','autofill','existing',?,'invite',1,'2026-11-11',0)",
      )
      .bind(user, generation),
    db
      .prepare("INSERT INTO funded_run_calls VALUES(?,?,'accepted',6,1,'2026-11-11',1)")
      .bind(call, generation),
    db
      .prepare("INSERT INTO funded_run_calls VALUES(?,?,'reserved',9,0,NULL,0)")
      .bind(crypto.randomUUID(), generation),
    db.prepare("INSERT INTO runs VALUES(?,'2026-11','autofill','monthly',1)").bind(user),
    db
      .prepare(
        "INSERT INTO funded_runs VALUES(?,'2026-11','autofill','monthly',?,'monthly',0,'2026-11-11',1)",
      )
      .bind(user, crypto.randomUUID()),
    db.prepare("INSERT INTO topup_claims VALUES(?,?,'granted')").bind(payment, checkout),
    db
      .prepare(
        "INSERT INTO topup_purchases VALUES(?,'pi_fixture','cs_fixture',?,'fixture',300,'usd',1,0,0,1,0,'2026-11-11T00:00:00.000Z')",
      )
      .bind(payment, user),
    db
      .prepare(
        "INSERT INTO topup_allocations VALUES(?,'2026-11','autofill','existing',?,'allocated')",
      )
      .bind(user, payment),
  ]);
  const tables = [
    "runs",
    "funded_runs",
    "funded_run_calls",
    "topup_allocations",
    "topup_purchases",
  ];
  const snapshot = () =>
    Promise.all(tables.map(async (t) => (await db.prepare(`SELECT * FROM ${t}`).all()).results));
  const before = await snapshot();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM topup_generation_allocations").first()).n,
    0,
  );
  await db.prepare("DELETE FROM runs").run();
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM funded_run_calls").first()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM topup_allocations").first()).n, 1);
});
