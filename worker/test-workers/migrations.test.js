// Local D1 only: neither binding is a production database or a provider client.
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";

const baselineName = "0001_baseline.sql";
const migrationNames = [
  baselineName,
  "0002_follow_lifecycle.sql",
  "0003_follow_digest_outbox.sql",
  "0004_topup_ledger.sql",
  "0005_topup_reconciliation.sql",
  "0006_topup_allocations.sql",
  "0008_topup_checkout_attempts.sql",
  "0013_topup_attempt_revisions.sql",
  "0015_topup_account_deletion.sql",
  "0017_funded_run_admission.sql",
  "0018_purchased_run_generations.sql",
];
const legacySql = [...env.TEST_SCHEMA_SQL, ...env.TEST_EXTRA_SCHEMA_SQL];
const databases = [env.LEGACY_DB, env.MIGRATION_DB];
const tableNames = env.TEST_SCHEMA_SQL.flatMap((sql) => {
  const match = sql.match(/CREATE TABLE IF NOT EXISTS "?(\w+)"?\s*\(/);
  return match ? [match[1]] : [];
});
const run = (db, queries) => db.batch(queries.map((sql) => db.prepare(sql)));
const rows = async (db, sql) => (await db.prepare(sql).all()).results;
const apply = () => applyD1Migrations(env.MIGRATION_DB, env.TEST_MIGRATIONS);
const ledger = () => rows(env.MIGRATION_DB, "SELECT name FROM d1_migrations ORDER BY id");

beforeEach(async () => {
  // Explicit cleanup also makes the proof independent of test-runner storage isolation defaults.
  for (const db of databases) {
    await run(
      db,
      [...tableNames.toReversed(), "d1_migrations"].map((name) => `DROP TABLE IF EXISTS "${name}"`),
    );
  }
});

async function initialize() {
  await run(env.LEGACY_DB, legacySql);
  await apply();
}

async function schema(db) {
  const objects = (
    await rows(db, "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
  ).filter(
    (row) =>
      !row.name.startsWith("sqlite_") &&
      !row.name.startsWith("_cf_") &&
      row.name !== "d1_migrations",
  );
  const tables = {};
  for (const name of tableNames) {
    tables[name] = {
      columns: await rows(db, `PRAGMA table_xinfo("${name}")`),
      indexes: await rows(db, `PRAGMA index_list("${name}")`),
      foreignKeys: await rows(db, `PRAGMA foreign_key_list("${name}")`),
    };
  }
  return { objects, tables };
}

it("the deduplicated migration creates the complete legacy schema, including constraints and triggers", async () => {
  expect(env.TEST_MIGRATIONS.map((migration) => migration.name)).toEqual(migrationNames);
  await initialize();
  const expected = await schema(env.LEGACY_DB);
  expect(await schema(env.MIGRATION_DB)).toEqual(expected);
  expect(expected.objects.filter((row) => row.type === "table")).toHaveLength(56);
  expect(expected.objects.filter((row) => row.type === "index")).toHaveLength(31);
  expect(expected.objects.filter((row) => row.type === "trigger")).toHaveLength(8);
  expect(await ledger()).toEqual(migrationNames.map((name) => ({ name })));
});

async function historicalRows(db) {
  const earlyTables = env.TEST_SCHEMA_SQL.filter((sql) =>
    /CREATE TABLE IF NOT EXISTS (usage|accounts|demand|plans|invite_codes|inviters|referrals)\s*\(/.test(
      sql,
    ),
  );
  expect(earlyTables).toHaveLength(7);
  await run(db, earlyTables);
  await run(db, [
    "INSERT INTO usage (user_hash,month,task) VALUES ('missing','2026-06','autofill'), ('back','2026-08','autofill'), ('same','2026-09','autofill'), ('early','2026-07','autofill')",
    "INSERT INTO accounts VALUES ('back','2026-09-24T12:00:00.000Z'), ('same','2026-09-24T12:00:00.000Z'), ('early','2026-05-02T00:00:00.000Z')",
    "INSERT INTO demand VALUES ('from-demand','[]','2026-01-02T00:00:00.000Z','2026-11-10T00:00:00.000Z')",
    "INSERT INTO plans (user_hash,updated) VALUES ('from-plan','2026-02-03T00:00:00.000Z')",
    "INSERT INTO invite_codes VALUES ('fixture-code','from-code','2026-03-04T00:00:00.000Z')",
    "INSERT INTO referrals VALUES ('a','r1',1,'fixture'), ('b','r1',1,'fixture'), ('c','r1',0,'fixture'), ('d','',1,'fixture'), ('e','r2',1,'fixture')",
    "INSERT INTO inviters VALUES ('r2',5)",
  ]);
}

async function backfillRows(db) {
  return {
    accounts: await rows(db, "SELECT * FROM accounts ORDER BY user_hash"),
    inviters: await rows(db, "SELECT * FROM inviters ORDER BY user_hash"),
  };
}

it("historical account and inviter backfills match the legacy path and fixed-data reruns are idempotent", async () => {
  for (const db of databases) await historicalRows(db);
  await initialize();
  const expected = await backfillRows(env.LEGACY_DB);
  expect(expected).toEqual({
    accounts: [
      { user_hash: "back", first: "2026-08-01T00:00:00.000Z" },
      { user_hash: "early", first: "2026-05-02T00:00:00.000Z" },
      { user_hash: "from-code", first: "2026-03-04T00:00:00.000Z" },
      { user_hash: "from-demand", first: "2026-01-02T00:00:00.000Z" },
      { user_hash: "from-plan", first: "2026-02-03T00:00:00.000Z" },
      { user_hash: "missing", first: "2026-06-01T00:00:00.000Z" },
      { user_hash: "same", first: "2026-09-24T12:00:00.000Z" },
    ],
    inviters: [
      { user_hash: "r1", rewarded: 2 },
      { user_hash: "r2", rewarded: 5 },
    ],
  });
  expect(await backfillRows(env.MIGRATION_DB)).toEqual(expected);
  await initialize();
  for (const db of databases) expect(await backfillRows(db)).toEqual(expected);
  expect(await ledger()).toEqual(migrationNames.map((name) => ({ name })));
});

async function triggerOutcomes(db) {
  const reserve = (order, listing, field) =>
    db
      .prepare(
        "INSERT INTO employer_capacity_reservations (order_id,listing_id,field,day,checked_at) VALUES (?,?,?,'2026-11-10','2026-11-10T00:00:00Z')",
      )
      .bind(order, listing, field);
  for (let n = 0; n < 5; n++) await reserve(`fixture-${n}`, `listing-${n}`, "fixture-field").run();
  await expect(
    db.batch([
      reserve("fixture-full", "listing-full", "other-field"),
      reserve("fixture-full", "listing-full", "fixture-field"),
    ]),
  ).rejects.toThrow(/employer_capacity_full/);
  expect(
    await rows(
      db,
      "SELECT order_id FROM employer_capacity_reservations WHERE order_id='fixture-full'",
    ),
  ).toEqual([]);
  await expect(reserve("fixture-duplicate", "listing-0", "other-field").run()).rejects.toThrow(
    /employer_listing_taken/,
  );
  await run(db, [
    "INSERT INTO employer_orders (id,created,updated,status,package,start_day,employer_key,employer,company,name,email,email_domain,terms_version,terms_at,price) VALUES ('fixture-order','2026-11-10','2026-11-10','unverified','one','2026-11-11','fixture','Fixture','Fixture','Fixture','test@example.test','example.test','fixture','2026-11-10',0)",
    "UPDATE employer_orders SET status='verified' WHERE id='fixture-order'",
    "UPDATE employer_orders SET status='paid', paid_amount=0 WHERE id='fixture-order'",
  ]);
  const counts = await rows(db, "SELECT day,event,page,n FROM event_counts ORDER BY event");
  expect(counts).toEqual(
    ["employer_comped", "employer_email_verified", "employer_order_created"].map((event) => ({
      day: "2026-11-10",
      event,
      page: "one",
      n: 1,
    })),
  );
  await db.prepare("DELETE FROM employer_orders WHERE id='fixture-order'").run();
  expect(await rows(db, "SELECT * FROM employer_funnel_marks")).toEqual([]);
  expect(await rows(db, "SELECT day,event,page,n FROM event_counts ORDER BY event")).toEqual(
    counts,
  );
  return counts;
}

it("migration-built capacity and funnel triggers preserve enforcement and aggregate outcomes", async () => {
  await initialize();
  expect(await triggerOutcomes(env.MIGRATION_DB)).toEqual(await triggerOutcomes(env.LEGACY_DB));
});

it("migration bookkeeping skips an applied baseline and rolls back a failed migration with its ledger row", async () => {
  await apply();
  await env.MIGRATION_DB.prepare(
    "INSERT INTO usage (user_hash,month,task) VALUES ('later','2026-10','autofill')",
  ).run();
  await apply();
  // Unlike schema.sql on every deploy, an already-applied migration does not rerun the backfills.
  expect(await rows(env.MIGRATION_DB, "SELECT * FROM accounts WHERE user_hash='later'")).toEqual(
    [],
  );
  await expect(
    applyD1Migrations(env.MIGRATION_DB, [
      {
        name: "9999_failure_fixture.sql",
        queries: [
          "CREATE TABLE migration_failure_probe (id INTEGER)",
          "INSERT INTO nonexistent_fixture_table VALUES (1)",
        ],
      },
    ]),
  ).rejects.toThrow();
  expect(
    await rows(
      env.MIGRATION_DB,
      "SELECT name FROM sqlite_schema WHERE name='migration_failure_probe'",
    ),
  ).toEqual([]);
  expect(await ledger()).toEqual(migrationNames.map((name) => ({ name })));
});
