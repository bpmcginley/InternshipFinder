import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, it } from "vitest";
import { maintainEmployerPostings } from "../src/employer-posting-maintenance.js";

let today, at;
const db = env.DB;
const offset = (days) => new Date(+at + days * 86400000).toISOString().slice(0, 10);
const run = (options = {}, database = db) =>
  maintainEmployerPostings(database, { enabled: true, now: () => new Date(at), ...options });
const rows = (table) => db.prepare(`SELECT * FROM ${table} ORDER BY day`).all();
const count = (day, company = "synthetic", n = 1) =>
  db.prepare("INSERT INTO employer_posting_counts VALUES(?,?,?)").bind(day, company, n).run();
const cap = (day, n = 0) =>
  db.prepare("INSERT INTO employer_posting_day_caps VALUES(?,?)").bind(day, n).run();

beforeEach(async () => {
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.batch([
    db.prepare("DELETE FROM employer_posting_counts"),
    db.prepare("DELETE FROM employer_posting_day_caps"),
  ]);
  today = (await db.prepare("SELECT date('now') AS day").first()).day;
  at = new Date(`${today}T12:00:00Z`);
});

it("is off by default and rejects invalid bounds before accessing D1", async () => {
  const forbidden = {
    prepare() {
      throw new Error("unexpected D1 access");
    },
  };
  assert.deepEqual(await maintainEmployerPostings(forbidden), { status: "disabled" });
  assert.deepEqual(await maintainEmployerPostings(forbidden, { enabled: "1" }), {
    status: "disabled",
  });
  for (const maxRows of [0, -1, 1001, 1.5, NaN])
    assert.deepEqual(await run({ maxRows }, forbidden), { status: "blocked" });
  assert.deepEqual(await run({ now: () => new Date(NaN) }, forbidden), { status: "blocked" });
});

it("rejects stale/future Worker dates without deleting or bootstrapping", async () => {
  await count(offset(-91));
  await cap(today, 19);
  const before = [await rows("employer_posting_counts"), await rows("employer_posting_day_caps")];
  for (const days of [-1, 1])
    assert.deepEqual(await run({ now: () => new Date(+at + days * 86400000) }), {
      status: "blocked",
    });
  assert.deepEqual((await rows("employer_posting_counts")).results, before[0].results);
  assert.deepEqual((await rows("employer_posting_day_caps")).results, before[1].results);
});

it("keeps the exact 90-day boundary and preserves the existing current cap", async () => {
  await count(offset(-91), "expired");
  await count(offset(-90), "boundary");
  await count(today, "current", 3);
  await cap(offset(-1), 17);
  await cap(today, 42);
  assert.deepEqual(await run(), { status: "ready" });
  assert.deepEqual(
    (await rows("employer_posting_counts")).results.map((r) => r.company),
    ["boundary", "current"],
  );
  assert.deepEqual((await rows("employer_posting_day_caps")).results, [{ day: today, n: 42 }]);
  await db.prepare("DELETE FROM employer_posting_counts").run();
  assert.deepEqual(await run(), { status: "ready" });
  assert.equal((await rows("employer_posting_day_caps")).results[0].n, 42);
});

it("does not reconstruct a missing cap from same-day counts or remove future caps", async () => {
  await count(today, "retained", 8);
  assert.deepEqual(await run(), { status: "blocked" });
  assert.equal((await rows("employer_posting_day_caps")).results.length, 0);
  await db.prepare("DELETE FROM employer_posting_counts").run();
  await cap(offset(1), 27);
  assert.deepEqual(await run(), { status: "blocked" });
  assert.deepEqual((await rows("employer_posting_day_caps")).results, [{ day: offset(1), n: 27 }]);
});

it("catches up in bounded batches and initializes only after the backlog is clean", async () => {
  for (let i = 0; i < 5; i++) {
    await count(offset(-91), `fake-${i}`);
    await cap(offset(-i - 1), i);
  }
  const changes = [];
  const measured = {
    prepare: (sql) => db.prepare(sql),
    batch: async (statements) => {
      const results = await db.batch(statements);
      changes.push(results.slice(0, 3).map((r) => r.meta.changes));
      return results;
    },
  };
  assert.deepEqual(await run({ maxRows: 2 }, measured), { status: "progress" });
  assert.deepEqual(await run({ maxRows: 2 }, measured), { status: "progress" });
  assert.deepEqual(await run({ maxRows: 2 }, measured), { status: "ready" });
  assert.deepEqual(changes, [
    [2, 2, 0],
    [2, 2, 0],
    [1, 1, 1],
  ]);
  assert.equal((await rows("employer_posting_counts")).results.length, 0);
  assert.deepEqual((await rows("employer_posting_day_caps")).results, [{ day: today, n: 0 }]);
});

it("future company rows block all maintenance writes with or without a current cap", async () => {
  await count(offset(-91), "expired");
  await count(offset(1), "future");
  await cap(offset(-1), 6);
  const before = (await rows("employer_posting_counts")).results;
  assert.deepEqual(await run(), { status: "blocked" });
  assert.deepEqual((await rows("employer_posting_counts")).results, before);
  assert.deepEqual((await rows("employer_posting_day_caps")).results, [{ day: offset(-1), n: 6 }]);
  await cap(today, 41);
  assert.deepEqual(await run(), { status: "blocked" });
  assert.deepEqual((await rows("employer_posting_counts")).results, before);
  assert.deepEqual((await rows("employer_posting_day_caps")).results, [
    { day: offset(-1), n: 6 },
    { day: today, n: 41 },
  ]);
});

it("future state arriving after the clock read prevents cleanup and initialization", async () => {
  await count(offset(-91), "expired");
  await cap(offset(-1), 7);
  const database = {
    prepare: (sql) => db.prepare(sql),
    batch: async (statements) => {
      await count(offset(1), "future");
      return db.batch(statements);
    },
  };
  assert.deepEqual(await run({}, database), { status: "blocked" });
  assert.equal((await rows("employer_posting_counts")).results.length, 2);
  assert.deepEqual((await rows("employer_posting_day_caps")).results, [{ day: offset(-1), n: 7 }]);
});

it("rolls back both cleanups if cap initialization fails, then recovers", async () => {
  await count(offset(-91));
  await cap(offset(-1), 5);
  await db
    .prepare(
      "CREATE TRIGGER synthetic_maintenance_failure BEFORE INSERT ON employer_posting_day_caps BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    )
    .run();
  try {
    assert.deepEqual(await run(), { status: "unavailable" });
    assert.equal((await rows("employer_posting_counts")).results.length, 1);
    assert.deepEqual((await rows("employer_posting_day_caps")).results, [
      { day: offset(-1), n: 5 },
    ]);
  } finally {
    await db.prepare("DROP TRIGGER synthetic_maintenance_failure").run();
  }
  assert.deepEqual(await run(), { status: "ready" });
});

it("concurrent invocations preserve one cap and never reset its consumed amount", async () => {
  await count(offset(-91));
  assert.deepEqual(await Promise.all([run(), run(), run()]), Array(3).fill({ status: "ready" }));
  await db.prepare("UPDATE employer_posting_day_caps SET n=97 WHERE day=?").bind(today).run();
  assert.deepEqual(await Promise.all([run(), run()]), Array(2).fill({ status: "ready" }));
  assert.deepEqual((await rows("employer_posting_day_caps")).results, [{ day: today, n: 97 }]);
});

// D1's real wall clock cannot be advanced. This wrapper runs the actual statements in
// local D1, changing only its SQL UTC expression between the initial read and batch.
function nextDatabaseDay() {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) {
          values = args;
          return this;
        },
        first: () =>
          db
            .prepare(sql)
            .bind(...values)
            .first(),
        sql,
        values: () => values,
      };
    },
    batch: (statements) =>
      db.batch(
        statements.map((s) =>
          db.prepare(s.sql.replaceAll("date('now')", "date('now','+1 day')")).bind(...s.values()),
        ),
      ),
  };
}

it("every mutation refuses a database-midnight change after the initial clock read", async () => {
  await count(offset(-91));
  await cap(offset(-1), 9);
  assert.deepEqual(await run({}, nextDatabaseDay()), { status: "blocked" });
  assert.equal((await rows("employer_posting_counts")).results.length, 1);
  assert.deepEqual((await rows("employer_posting_day_caps")).results, [{ day: offset(-1), n: 9 }]);
});

it("does not report ready after Worker midnight or clock regression", async () => {
  for (const later of [new Date(+at + 86400000), new Date(+at - 1)]) {
    let calls = 0;
    assert.deepEqual(await run({ now: () => new Date(calls++ ? later : at) }), {
      status: "blocked",
    });
  }
  assert.deepEqual(await run(), { status: "ready" });
});

it("fails closed for unavailable or malformed D1 results", async () => {
  const database = { prepare: (sql) => db.prepare(sql), batch: async () => [] };
  assert.deepEqual(await run({}, database), { status: "unavailable" });
  assert.deepEqual(
    await run(
      {},
      {
        prepare() {
          throw new Error("synthetic");
        },
      },
    ),
    { status: "unavailable" },
  );
});

it("uses bounded indexed range scans with a synthetic retained-history backlog", async () => {
  await db
    .prepare(
      "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<2001) INSERT INTO employer_posting_counts SELECT ?,printf('fake-%05d',n),1 FROM seq",
    )
    .bind(offset(-91))
    .run();
  const observed = [];
  const database = {
    prepare: (sql) => {
      observed.push(sql);
      return db.prepare(sql);
    },
    batch: (statements) => db.batch(statements),
  };
  assert.deepEqual(await run({}, database), { status: "progress" });
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM employer_posting_counts").first()).n,
    1001,
  );
  const countPlan = await db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT day,company FROM employer_posting_counts WHERE day<date(?,'-90 days') ORDER BY day,company LIMIT ?",
    )
    .bind(today, 1000)
    .all();
  const capPlan = await db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT day FROM employer_posting_day_caps WHERE day<? ORDER BY day LIMIT ?",
    )
    .bind(today, 1000)
    .all();
  for (const plan of [countPlan, capPlan])
    assert.ok(
      plan.results.some((r) => /SEARCH .* USING COVERING INDEX .*\(day<\?\)/.test(r.detail)),
    );
  for (const sql of observed.slice(1, 3)) {
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(today, today, today, today, 1000)
      .all();
    assert.ok(plan.results.filter((r) => /SEARCH employer_posting_/.test(r.detail)).length >= 2);
    assert.ok(!plan.results.some((r) => /SCAN employer_posting_/.test(r.detail)));
    assert.equal(
      plan.results.filter((r) => /SEARCH .* USING COVERING INDEX .*\(day>\?\)/.test(r.detail))
        .length,
      2,
    );
  }
  assert.equal(observed.length, 5, "one clock read and one four-statement batch");
});
