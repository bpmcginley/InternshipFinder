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

async function prefix(db, healthy, orphans = 1) {
  const at = await clock(db);
  const writes = [];
  for (let i = 1; i <= healthy + orphans; i++) {
    writes.push(
      db
        .prepare("INSERT INTO follow_subscribers(rowid,id,email,created) VALUES(?,?,?,?)")
        .bind(i, `prefix-${i}`, `prefix-${i}@example.test`, at),
    );
    if (i <= healthy)
      writes.push(
        db
          .prepare("INSERT INTO follow_subscriptions VALUES(?,'keep',?,?,NULL)")
          .bind(`prefix-${i}`, at, at),
      );
  }
  await db.batch(writes);
}

function measured(beforeOrphan = async () => {}) {
  const pages = [];
  let calls = 0;
  const db = {
    prepare(sql) {
      const wrap = (statement) => ({
        sql,
        statement,
        bind: (...args) => wrap(statement.bind(...args)),
        all: () => {
          calls++;
          return statement.all();
        },
      });
      return wrap(env.DB.prepare(sql));
    },
    async batch(statements) {
      calls++;
      const orphan =
        statements.length === 9 && statements[7].sql.includes("DELETE FROM follow_subscribers");
      if (orphan) await beforeOrphan();
      const result = await env.DB.batch(statements.map((s) => s.statement));
      if (orphan) pages.push(result);
      return result;
    },
  };
  return { db, pages, calls: () => calls };
}

it("reaches an orphan after 41 healthy roots within the unchanged 48-call scheduler budget", async () => {
  await reset(env.DB);
  await prefix(env.DB, 41);
  const before = await env.DB.prepare(
    "SELECT * FROM follow_subscriptions ORDER BY subscriber_id",
  ).all();
  const m = measured();
  const wide = JSON.stringify({ deadlineMs: 30000, maxD1Calls: 48, maxRows: 128 });
  await expect(
    Promise.all(run({ ...settings, DB: m.db, FOLLOW_MAINTENANCE_POLICY: wide })),
  ).resolves.toEqual([{ status: "pass-complete" }]);
  expect(m.calls()).toBe(8);
  expect(m.pages).toHaveLength(1);
  expect(m.pages[0][1].results).toEqual([{ examined: 42, last: "42" }]);
  expect(m.pages[0][8].results).toEqual([{ changed: 1 }]);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM follow_subscribers").first("n")).toBe(41);
  expect(
    (await env.DB.prepare("SELECT * FROM follow_subscriptions ORDER BY subscriber_id").all())
      .results,
  ).toEqual(before.results);
});

it("retains maxRows one legacy orphan receipts and one call per page", async () => {
  await reset(env.DB);
  await prefix(env.DB, 2);
  const m = measured();
  const one = JSON.stringify({ deadlineMs: 30000, maxD1Calls: 48, maxRows: 1 });
  await expect(runFollowScheduledMaintenance(m.db, one)).resolves.toEqual({
    status: "pass-complete",
  });
  expect(m.pages).toHaveLength(3);
  expect(m.pages.map((r) => r[1].results[0].examined)).toEqual([1, 1, 1]);
  expect(m.pages.map((r) => r[2].results)).toEqual([
    [{ eligible: 0 }],
    [{ eligible: 0 }],
    [{ eligible: 1 }],
  ]);
  expect(m.pages.map((r) => r[8].results[0].changed)).toEqual([0, 0, 1]);
  expect(m.calls()).toBe(11);
});

it("bounds both lookahead and child drainage by the existing row policy", async () => {
  await reset(env.DB);
  await prefix(env.DB, 2);
  await env.DB.batch(
    Array.from({ length: 5 }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO follow_tokens VALUES(?,'prefix-3','unsubscribe','','generation',NULL,NULL)",
      ).bind(`child-${i}`),
    ),
  );
  const m = measured();
  const small = JSON.stringify({ deadlineMs: 30000, maxD1Calls: 48, maxRows: 2 });
  await expect(runFollowScheduledMaintenance(m.db, small)).resolves.toEqual({
    status: "pass-complete",
  });
  expect(m.pages).toHaveLength(4);
  expect(m.pages.map((r) => r[1].results[0].examined)).toEqual([2, 1, 1, 1]);
  expect(m.pages.map((r) => r[4].results[0].changed)).toEqual([0, 2, 2, 1]);
  expect(m.pages.map((r) => r[8].results[0].changed)).toEqual([0, 0, 0, 1]);
  expect(m.calls()).toBeLessThanOrEqual(48);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM follow_subscribers").first("n")).toBe(2);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM follow_tokens").first("n")).toBe(0);
});

it("preserves a scope created before the decisive orphan batch", async () => {
  await reset(env.DB);
  await prefix(env.DB, 1);
  const at = await clock(env.DB);
  let added = false;
  const m = measured(async () => {
    if (!added) {
      added = true;
      await env.DB.prepare("INSERT INTO follow_subscriptions VALUES('prefix-2','raced',?,?,NULL)")
        .bind(at, at)
        .run();
    }
  });
  await expect(runFollowScheduledMaintenance(m.db, policy)).resolves.toEqual({
    status: "pass-complete",
  });
  expect(m.pages).toHaveLength(1);
  expect(m.pages[0][2].results[0].eligible).toBe(0);
  expect(m.pages[0][8].results[0].changed).toBe(0);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM follow_subscribers").first("n")).toBe(2);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM follow_subscriptions").first("n")).toBe(2);
});

it("competing scheduler passes delete the later orphan only once", async () => {
  await reset(env.DB);
  await prefix(env.DB, 41);
  const a = measured(),
    b = measured();
  const wide = JSON.stringify({ deadlineMs: 30000, maxD1Calls: 48, maxRows: 128 });
  await expect(
    Promise.all([
      runFollowScheduledMaintenance(a.db, wide),
      runFollowScheduledMaintenance(b.db, wide),
    ]),
  ).resolves.toEqual([{ status: "pass-complete" }, { status: "pass-complete" }]);
  expect([...a.pages, ...b.pages].reduce((sum, r) => sum + r[8].results[0].changed, 0)).toBe(1);
  expect(a.calls()).toBeLessThanOrEqual(48);
  expect(b.calls()).toBeLessThanOrEqual(48);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM follow_subscribers").first("n")).toBe(41);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM follow_subscriptions").first("n")).toBe(
    41,
  );
});
