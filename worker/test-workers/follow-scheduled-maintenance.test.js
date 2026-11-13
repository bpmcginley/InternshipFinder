import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { runFollowScheduledMaintenance } from "../src/follow-scheduled-maintenance.js";

const cron = "13 2 * * *";
const policy = JSON.stringify({ deadlineMs: 30000, maxD1Calls: 16, maxRows: 4 });
const settings = {
  FOLLOW_MAINTENANCE_CRON: cron,
  FOLLOW_MAINTENANCE_POLICY: policy,
  FOLLOW_MAINTENANCE_ENABLED: "1",
};

function run(bindings, at = cron) {
  const pending = [];
  worker.scheduled({ cron: at, scheduledTime: Date.now() - 86400000 }, bindings, {
    waitUntil: (promise) => pending.push(promise),
  });
  return pending;
}

const clock = (db) => db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at").first("at");

async function reset(db) {
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.batch(
    ["follow_subscribers", "follow_digest_days", "follow_send_budget"].map((table) =>
      db.prepare(`DELETE FROM ${table}`),
    ),
  );
  await db.prepare("UPDATE follow_delivery_owner SET phase='held',next_kind='management'").run();
}

it("keeps the exact scheduled branch off or unavailable without falling through", async () => {
  const read = vi.fn(() => {
    throw new Error("Unexpected D1 access");
  });
  const bindings = { ...settings, DB: { prepare: read, batch: read } };
  for (const enabled of [undefined, "0", true]) {
    expect(run({ ...bindings, FOLLOW_MAINTENANCE_ENABLED: enabled })).toEqual([]);
  }
  for (const malformed of [
    undefined,
    "{}",
    "[]",
    "null",
    "{",
    JSON.stringify({ deadlineMs: 100, maxD1Calls: 49, maxRows: 1 }),
  ]) {
    await expect(
      Promise.all(run({ ...bindings, FOLLOW_MAINTENANCE_POLICY: malformed })),
    ).resolves.toEqual([{ status: "unavailable" }]);
  }
  for (const mismatch of [undefined, "", "14 2 * * *"]) {
    expect(run({ ...bindings, FOLLOW_MAINTENANCE_CRON: mismatch })).toEqual([]);
  }
  expect(read).not.toHaveBeenCalled();
});

it("the repository clock retains priority over a colliding descriptor", async () => {
  const read = vi.fn(() => {
    throw new Error("Unexpected D1 access");
  });
  const clockCron = "4,34 * * * *";
  const pending = run(
    { ...settings, DB: { prepare: read, batch: read }, FOLLOW_MAINTENANCE_CRON: clockCron },
    clockCron,
  );
  expect(pending).toHaveLength(1);
  await expect(Promise.all(pending)).resolves.toEqual([
    { started: false, why: "no GITHUB_DISPATCH_TOKEN" },
  ]);
  expect(read).not.toHaveBeenCalled();
});

it("removes expired records on the real scheduled entry while delivery ownership is held", async () => {
  await reset(env.DB);
  const now = await clock(env.DB);
  const before = new Date(Date.parse(now) - 9 * 86400000).toISOString();
  const live = new Date(Date.parse(now) + 60000).toISOString();
  const owner = await env.DB.prepare("SELECT * FROM follow_delivery_owner").first();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO follow_subscribers VALUES('expire','expire@example.test',?,NULL,NULL),('keep','keep@example.test',?,NULL,NULL)",
    ).bind(before, now),
    env.DB.prepare(
      "INSERT INTO follow_subscriptions VALUES('expire','scope',?,NULL,NULL),('keep','scope',?,NULL,NULL)",
    ).bind(before, now),
    env.DB.prepare(
      "INSERT INTO follow_tokens VALUES('expire-token','expire','confirm','scope','generation',?,NULL)",
    ).bind(now),
    env.DB.prepare("INSERT INTO follow_digest_days VALUES(?,?),(?,?)").bind(
      "1".repeat(64),
      now,
      "2".repeat(64),
      live,
    ),
    env.DB.prepare("INSERT INTO follow_send_budget VALUES(1,?,2)").bind(now),
  ]);
  const send = vi.fn();
  const bindings = { ...settings, DB: env.DB, EMAIL: { send }, FOLLOW_SIGNUP_ENABLED: "1" };
  const result = run(bindings);
  expect(result).toHaveLength(1);
  await expect(Promise.all(result)).resolves.toEqual([{ status: "pass-complete" }]);
  expect(await env.DB.prepare("SELECT id FROM follow_subscribers").first("id")).toBe("keep");
  expect(await env.DB.prepare("SELECT count(*) AS total FROM follow_tokens").first("total")).toBe(
    0,
  );
  expect(await env.DB.prepare("SELECT marker FROM follow_digest_days").first("marker")).toBe(
    "2".repeat(64),
  );
  expect(await env.DB.prepare("SELECT * FROM follow_delivery_owner").first()).toEqual(owner);
  expect(await env.DB.prepare("SELECT attempts FROM follow_send_budget").first("attempts")).toBe(2);
  expect(send).not.toHaveBeenCalled();
});

it("reports budget exhaustion and never retries an uncertain page", async () => {
  await reset(env.DB);
  let calls = 0;
  const db = {
    prepare: (sql) => env.DB.prepare(sql),
    batch: async (statements) => {
      calls++;
      await env.DB.batch(statements);
      throw new Error("Synthetic lost acknowledgement");
    },
  };
  await expect(Promise.all(run({ ...settings, DB: db }))).resolves.toEqual([
    { status: "unavailable" },
  ]);
  expect(calls).toBe(1);

  let time = 0;
  const slowDb = {
    prepare: (sql) => env.DB.prepare(sql),
    batch: async (statements) => {
      calls++;
      const result = await env.DB.batch(statements);
      time = 30000;
      return result;
    },
  };
  await expect(runFollowScheduledMaintenance(slowDb, policy, () => time)).resolves.toEqual({
    status: "partial",
  });
  expect(calls).toBe(2);
});

it("reports a partial pass when the binding call budget cannot admit another page", async () => {
  await reset(env.DB);
  const now = await clock(env.DB);
  await env.DB.prepare(
    "INSERT INTO follow_subscribers VALUES('queued','queued@example.test',?,NULL,NULL)",
  )
    .bind(now)
    .run();
  await env.DB.prepare("INSERT INTO follow_subscriptions VALUES('queued','live',?,NULL,NULL)")
    .bind(now)
    .run();
  const batch = vi.fn((statements) => env.DB.batch(statements));
  const prepare = vi.fn((sql) => env.DB.prepare(sql));
  const db = { batch, prepare };
  const small = JSON.stringify({ deadlineMs: 30000, maxD1Calls: 5, maxRows: 1 });
  await expect(
    Promise.all(run({ ...settings, DB: db, FOLLOW_MAINTENANCE_POLICY: small })),
  ).resolves.toEqual([{ status: "partial" }]);
  // The digest lane needs two calls and the fifth unit alone cannot admit its clock read.
  expect(batch).toHaveBeenCalledTimes(4);
  expect(
    prepare.mock.calls.some(([sql]) => sql === "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at"),
  ).toBe(false);
});

it("does not admit the digest mutation after its database clock read spends the deadline", async () => {
  await reset(env.DB);
  let time = 0;
  const batch = vi.fn((statements) => env.DB.batch(statements));
  const db = {
    batch,
    prepare(sql) {
      const statement = env.DB.prepare(sql);
      if (!sql.startsWith("SELECT strftime(")) return statement;
      return {
        async all() {
          const result = await statement.all();
          time = 30000;
          return result;
        },
      };
    },
  };
  await expect(runFollowScheduledMaintenance(db, policy, () => time)).resolves.toEqual({
    status: "partial",
  });
  expect(batch).toHaveBeenCalledTimes(4);
});
