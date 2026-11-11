import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { it } from "vitest";
import * as scenarios from "../test-support/funded-run-admission.js";
for (const scenario of Object.values(scenarios))
  it(`local D1: ${scenario.name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await scenario(env.DB);
  });

it("0017 preserves preexisting committed runs without backfilling refundable funding", async () => {
  const db = env.MIGRATION_DB;
  await applyD1Migrations(
    db,
    env.TEST_MIGRATIONS.filter((m) => !/^001[78]_/.test(m.name)),
  );
  await db
    .prepare("INSERT INTO runs VALUES('legacy-fixture','2026-10','autofill','legacy',2)")
    .run();
  await db.prepare("INSERT INTO usage VALUES('legacy-fixture','2026-10','autofill',1)").run();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  const { default: assert } = await import("node:assert/strict");
  assert.equal(
    (await db.prepare("SELECT calls FROM runs WHERE user_hash='legacy-fixture'").first()).calls,
    2,
  );
  assert.equal(
    (await db.prepare("SELECT units FROM usage WHERE user_hash='legacy-fixture'").first()).units,
    1,
  );
  assert.deepEqual((await db.prepare("SELECT * FROM funded_runs").all()).results, []);
  assert.deepEqual((await db.prepare("SELECT * FROM funded_run_calls").all()).results, []);
});
