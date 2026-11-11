// Local D1 only. The published Worker and production database are outside this test.
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { expect, it } from "vitest";
import backfills from "../deploy-backfills.sql?raw";

const baselineName = "0001_baseline.sql";
const run = (db, queries) => db.batch(queries.map((query) => db.prepare(query)));
const rows = async (db, query) => (await db.prepare(query).all()).results;

it("runs the exact recurring backfills after both fresh and already-adopted migrations", async () => {
  const legacy = env.LEGACY_DB;
  const migrated = env.MIGRATION_DB;
  const baseline = env.TEST_MIGRATIONS.filter(({ name }) => name === baselineName);
  expect(baseline).toHaveLength(1);
  const recurring = env.TEST_SCHEMA_SQL.filter((query) =>
    /^INSERT INTO (accounts|inviters) /.test(query),
  ).map((query) => query.replaceAll("\r\n", "\n"));
  expect(recurring).toHaveLength(2);
  expect(backfills.trim().replaceAll("\r\n", "\n")).toBe(recurring.join(";\n\n") + ";");

  await run(legacy, env.TEST_SCHEMA_SQL);
  await applyD1Migrations(migrated, baseline);
  const fresh = await run(migrated, recurring);
  expect(fresh.map(({ meta }) => meta.changes)).toEqual([0, 0]);
  const ledger = "SELECT name FROM d1_migrations ORDER BY id";
  expect(await rows(migrated, ledger)).toEqual([{ name: baselineName }]);

  // Rows that arrive after adoption are invisible to an already-applied migration.
  const later = [
    "INSERT INTO usage (user_hash, month, task) VALUES ('missing','2026-06','autofill'), ('earlier','2026-08','autofill'), ('same','2026-09','autofill')",
    "INSERT INTO accounts VALUES ('earlier','2026-09-24T12:00:00.000Z'), ('same','2026-09-24T12:00:00.000Z')",
    "INSERT INTO demand VALUES ('from-demand','[]','2026-01-02T00:00:00.000Z','2026-11-10T00:00:00.000Z')",
    "INSERT INTO plans (user_hash, updated) VALUES ('from-plan','2026-02-03T00:00:00.000Z')",
    "INSERT INTO invite_codes VALUES ('fixture-code','from-code','2026-03-04T00:00:00.000Z')",
    "INSERT INTO referrals VALUES ('a','raised',1,'fixture'), ('b','raised',1,'fixture'), ('c','raised',0,'fixture'), ('d','',1,'fixture'), ('e','kept',1,'fixture')",
    "INSERT INTO inviters VALUES ('raised',1), ('kept',5)",
  ];
  await run(legacy, later);
  await run(migrated, later);
  const accounts = "SELECT * FROM accounts ORDER BY user_hash";
  const inviters = "SELECT * FROM inviters ORDER BY user_hash";
  await applyD1Migrations(migrated, baseline);
  expect(await rows(migrated, accounts)).toHaveLength(2);
  expect(await rows(migrated, inviters)).toContainEqual({ user_hash: "raised", rewarded: 1 });

  await run(legacy, env.TEST_SCHEMA_SQL);
  await run(migrated, recurring);
  expect(await rows(migrated, accounts)).toEqual(await rows(legacy, accounts));
  expect(await rows(migrated, accounts)).toEqual([
    { user_hash: "earlier", first: "2026-08-01T00:00:00.000Z" },
    { user_hash: "from-code", first: "2026-03-04T00:00:00.000Z" },
    { user_hash: "from-demand", first: "2026-01-02T00:00:00.000Z" },
    { user_hash: "from-plan", first: "2026-02-03T00:00:00.000Z" },
    { user_hash: "missing", first: "2026-06-01T00:00:00.000Z" },
    { user_hash: "same", first: "2026-09-24T12:00:00.000Z" },
  ]);
  expect(await rows(migrated, inviters)).toEqual(await rows(legacy, inviters));
  expect(await rows(migrated, inviters)).toEqual([
    { user_hash: "kept", rewarded: 5 },
    { user_hash: "raised", rewarded: 2 },
  ]);
  const repeated = await run(migrated, recurring);
  expect(repeated.map(({ meta }) => meta.changes)).toEqual([0, 0]);
  expect(await rows(migrated, ledger)).toEqual([{ name: baselineName }]);
});
