import {
  createCachedEmployerPostingCounter,
  createEmployerMinuteBudget,
  createEmployerPostingCounter,
  EMPLOYER_POSTING_EVENT,
} from "../src/employer-posting-counts.js";

// Test-only schema: no production migration or shared baseline is changed.
export const EMPLOYER_COUNT_SCHEMA = `CREATE TABLE employer_posting_counts (
  day TEXT NOT NULL, company TEXT NOT NULL, n INTEGER NOT NULL CHECK(n BETWEEN 1 AND 1000),
  PRIMARY KEY(day, company)
)`;
export const EMPLOYER_DAY_CAP_SCHEMA = `CREATE TABLE employer_posting_day_caps (
  day TEXT PRIMARY KEY NOT NULL, n INTEGER NOT NULL CHECK(typeof(n) = 'integer' AND n BETWEEN 0 AND 50000)
)`;
const eq = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label);
};
const event = (c = "acme") => ({ e: EMPLOYER_POSTING_EVENT, c });

export async function employerCachedCounterScenario(db) {
  await db.prepare(EMPLOYER_COUNT_SCHEMA).run();
  await db.prepare(EMPLOYER_DAY_CAP_SCHEMA).run();
  const start = Date.parse("2026-12-15T12:00:00Z");
  const address = "192.0.2.90";
  let time = start,
    loads = 0,
    finishLoad,
    crossingExpiry = false,
    expiryReads = 0;
  const count = createCachedEmployerPostingCounter({
    db,
    maxBytes: 64,
    now: () => new Date(crossingExpiry && ++expiryReads === 5 ? time + 1 : time),
    load() {
      loads++;
      if (loads === 1) return new Response('["acme"]');
      if (loads === 2) return new Response('["acme","acme"]');
      if (loads === 3) return new Response('["newco"]');
      return new Promise((resolve) => {
        finishLoad = resolve;
      });
    },
  });
  eq(await count.count(event(), address), false, "retention gate precedes catalog load");
  eq(await count.cleanup(), true, "day cap initialized");
  eq(await count.count({ ...event(), n: 8 }, address), false, "malformed body denied");
  eq(loads, 0, "unready and malformed requests never start a load");
  eq(await count.count(event(), address), true, "initial key admitted");
  eq(await count.count(event("newco"), address), false, "unknown key denied");
  eq(loads, 1, "same snapshot reused");

  time = start + 299_999;
  // The counter and the cache use four reads before control returns to the D1 admission fence.
  crossingExpiry = true;
  eq(
    await count.count(event(), address),
    false,
    "expiry between cache match and D1 admits nothing",
  );
  crossingExpiry = false;
  time = start + 300_000;
  eq(await count.count(event(), address), false, "duplicate keys invalidate expired refresh");
  time += 4_999;
  eq(await count.count(event(), address), false, "stale key never admits during backoff");
  eq(loads, 2, "failure backoff coalesces retries");
  time++;
  eq(await count.count(event(), address), false, "old key removed after fresh catalog");
  eq(await count.count(event("newco"), address), true, "new key admitted after refresh");

  time = Date.parse("2026-12-15T23:59:59Z");
  const previousDay = count.count(event("newco"), address);
  time += 1_000;
  eq(await count.cleanup(), true, "UTC rollover reestablishes retention");
  finishLoad(new Response('["newco"]'));
  eq(await previousDay, false, "in-flight previous-day count is discarded");
  eq(await count.count(event("newco"), address), true, "current UTC day accepts a new click");

  time += 300_000;
  const previousCleanup = count.count(event("newco"), address);
  eq(await count.cleanup(), true, "a new cleanup generation can succeed on the same day");
  finishLoad(new Response('["newco"]'));
  eq(await previousCleanup, false, "same-day obsolete admission is discarded");

  const companies = await db
    .prepare("SELECT * FROM employer_posting_counts ORDER BY day, company")
    .all();
  const caps = await db.prepare("SELECT * FROM employer_posting_day_caps ORDER BY day").all();
  eq(
    companies.results,
    [
      { day: "2026-12-15", company: "acme", n: 1 },
      { day: "2026-12-15", company: "newco", n: 1 },
      { day: "2026-12-16", company: "newco", n: 1 },
    ],
    "only three admitted clicks persist",
  );
  eq(caps.results, [{ day: "2026-12-16", n: 1 }], "only current-day aggregate survives");
}

export async function employerCounterScenario(db) {
  await db.prepare(EMPLOYER_COUNT_SCHEMA).run();
  await db.prepare(EMPLOYER_DAY_CAP_SCHEMA).run();
  let time = new Date("2026-11-10T23:59:59Z");
  const keys = ["acme", "a & b", "é".repeat(100)];
  const core = createEmployerPostingCounter({ db, keys, now: () => time });
  keys.push("mutated");
  const rows = async () =>
    (await db.prepare("SELECT * FROM employer_posting_counts ORDER BY company").all()).results;
  eq(await core.count(event(), "192.0.2.1"), false, "cleanup must precede collection");
  eq(await core.cleanup(), true, "initial cleanup");
  const invalid = [
    null,
    [],
    {},
    { e: EMPLOYER_POSTING_EVENT },
    { ...event(), n: 9 },
    { ...event(), day: "2020-01-01" },
    { ...event(), url: "https://example.test/" },
    { ...event(), e: "open" },
    event("mutated"),
    event("unknown"),
    event(" acme"),
    event("é".repeat(101)),
    event("acme\u0000"),
    event("\ud800"),
  ];
  for (const body of invalid)
    eq(await core.count(body, "192.0.2.2"), false, "strict event validation");
  eq(await rows(), [], "invalid events write nothing");
  eq(await core.count(event("é".repeat(100)), "192.0.2.3"), true, "200 UTF-8 bytes accepted");
  eq(await core.count(event(), "192.0.2.3"), true, "known key accepted");
  eq(
    (await rows())[0],
    { day: "2026-11-10", company: "acme", n: 1 },
    "only aggregate fields stored",
  );
  for (const snapshot of [
    null,
    {},
    [],
    [""],
    ["acme", "acme"],
    ["é".repeat(101)],
    ["\u0000"],
    Array(10001).fill("a"),
  ]) {
    const bad = createEmployerPostingCounter({ db, keys: snapshot, now: () => time });
    eq(await bad.cleanup(), false, "invalid snapshot fails closed");
    eq(await bad.count(event(), "192.0.2.3"), false, "invalid snapshot never writes");
  }
  const maximum = createEmployerPostingCounter({
    db,
    keys: Array.from({ length: 10000 }, (_, i) => `k${i}`),
    now: () => time,
  });
  eq(await maximum.cleanup(), true, "10000 keys accepted");
  eq(await maximum.count(event("k9999"), "192.0.2.3"), true, "last maximum key recognized");

  time = new Date("2026-11-10T19:00:00-05:00");
  eq(await core.count(event(), "192.0.2.3"), false, "UTC rollover needs cleanup");
  eq(await core.cleanup(), true, "new UTC day cleanup");
  eq(await core.count(event(), "192.0.2.3"), true, "new UTC day counts");
  eq(
    await db
      .prepare(
        "SELECT n FROM employer_posting_counts WHERE day = '2026-11-11' AND company = 'acme'",
      )
      .first("n"),
    1,
    "server UTC day",
  );
  await db.prepare("DELETE FROM employer_posting_counts").run();
  await db.prepare("INSERT INTO employer_posting_counts VALUES ('2026-11-11', 'acme', 998)").run();
  await db.prepare("UPDATE employer_posting_day_caps SET n = 998 WHERE day = '2026-11-11'").run();
  const companyRace = await Promise.all(
    Array.from({ length: 20 }, (_, i) => core.count(event(), `192.0.2.${i + 10}`)),
  );
  eq(companyRace.filter(Boolean).length, 2, "atomic per-company cap");
  eq((await rows())[0].n, 1000, "per-company ceiling");
  eq(
    await db.prepare("SELECT n FROM employer_posting_day_caps WHERE day = '2026-11-11'").first("n"),
    1000,
    "rejected company hits consume no global capacity",
  );

  await db.prepare("DELETE FROM employer_posting_counts").run();
  const many = Array.from({ length: 70 }, (_, i) => `company${i}`);
  for (let i = 0; i < 50; i++)
    await db
      .prepare("INSERT INTO employer_posting_counts VALUES (?, ?, ?)")
      .bind("2026-11-11", many[i], i === 49 ? 998 : 1000)
      .run();
  await db.prepare("UPDATE employer_posting_day_caps SET n = 49998 WHERE day = '2026-11-11'").run();
  // Separate counter instances share the DB cap and this isolate's minute budget.
  const instances = many
    .slice(50)
    .map(() => createEmployerPostingCounter({ db, keys: many, now: () => time }));
  await Promise.all(instances.map((c) => c.cleanup()));
  const globalRace = await Promise.all(
    instances.map((c, i) => c.count(event(many[50 + i]), "192.0.2.1")),
  );
  eq(globalRace.filter(Boolean).length, 2, "atomic cross-instance global cap");
  eq(
    await db.prepare("SELECT SUM(n) AS n FROM employer_posting_counts").first("n"),
    50000,
    "global ceiling",
  );
  eq(
    await db.prepare("SELECT n FROM employer_posting_day_caps WHERE day = '2026-11-11'").first("n"),
    50000,
    "both aggregates reach global ceiling together",
  );

  await db.prepare("DELETE FROM employer_posting_counts").run();
  for (const day of ["2026-08-12", "2026-08-13", "2026-11-11"])
    await db.prepare("INSERT INTO employer_posting_counts VALUES (?, 'acme', 1)").bind(day).run();
  // Direct fixture resets seed both coherent aggregates; owner deletion must never do this.
  await db.prepare("UPDATE employer_posting_day_caps SET n = 1 WHERE day = '2026-11-11'").run();
  eq(await core.cleanup(), true, "retention cleanup");
  eq(
    (await db.prepare("SELECT day FROM employer_posting_counts ORDER BY day").all()).results.map(
      (r) => r.day,
    ),
    ["2026-08-13", "2026-11-11"],
    "keep today and previous 90 UTC days, no rollup",
  );
  let fail = false;
  const flaky = {
    batch: (statements) => db.batch(statements),
    prepare: (sql) => {
      if (fail && sql.startsWith("DELETE")) throw new Error("synthetic cleanup failure");
      return db.prepare(sql);
    },
  };
  const recovery = createEmployerPostingCounter({ db: flaky, keys: ["acme"], now: () => time });
  eq(await recovery.cleanup(), true, "recovery baseline");
  fail = true;
  eq(await recovery.cleanup(), false, "cleanup failure");
  eq(await recovery.count(event(), "192.0.2.1"), false, "collection off after failure");
  fail = false;
  eq(await recovery.cleanup(), true, "cleanup recovery");
  eq(await recovery.count(event(), "192.0.2.1"), true, "resume without replay");
  let release;
  const delayed = {
    prepare: (sql) => db.prepare(sql),
    batch: async (statements) => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return db.batch(statements);
    },
  };
  const pending = createEmployerPostingCounter({ db: delayed, keys: ["acme"], now: () => time });
  const oldCleanup = pending.cleanup();
  time = new Date("2026-11-12T00:00:00Z");
  release({ success: true });
  eq(await oldCleanup, false, "old cleanup cannot enable a new UTC day");
  eq(await pending.count(event(), "192.0.2.1"), false, "stale cleanup stays disabled");
  const swapped = Array.from({ length: 31 }, () =>
    createEmployerPostingCounter({ db, keys: ["acme"], now: () => time }),
  );
  await Promise.all(swapped.map((c) => c.cleanup()));
  const refreshed = await Promise.all(swapped.map((c) => c.count(event(), "192.0.2.99")));
  eq(refreshed.filter(Boolean).length, 30, "snapshot/core replacement cannot reset isolate budget");
  return "validation, UTC, atomic caps and retention passed";
}

export async function employerDayCapScenario(db) {
  await db.prepare(EMPLOYER_COUNT_SCHEMA).run();
  await db.prepare(EMPLOYER_DAY_CAP_SCHEMA).run();
  let time = new Date("2026-11-15T12:00:00Z");
  const make = (database = db) =>
    createEmployerPostingCounter({ db: database, keys: ["acme"], now: () => time });
  const total = () =>
    db
      .prepare("SELECT n FROM employer_posting_day_caps WHERE day = ?")
      .bind(time.toISOString().slice(0, 10))
      .first("n");
  const core = make();
  await db.prepare("INSERT INTO employer_posting_counts VALUES ('2026-11-15', 'acme', 9)").run();
  eq(await core.cleanup(), false, "missing cap plus existing history must fail closed");
  eq(await total(), null, "never rebuild an ambiguous cap from retained counts");
  // Recovery advances to an empty day; no guessed initial total or retroactive collection.
  time = new Date("2026-11-16T00:00:00Z");
  eq(await core.cleanup(), true, "empty new UTC day initializes once");
  eq(await core.count(event(), "192.0.2.150"), true, "initial count");
  await db.prepare("DELETE FROM employer_posting_counts WHERE day = '2026-11-16'").run();
  const restarted = make();
  eq(await restarted.cleanup(), true, "restart after owner count deletion");
  eq(await total(), 1, "owner deletion/restart never releases consumed daily capacity");
  eq(await restarted.count(event(), "192.0.2.150"), true, "new count after deletion");
  eq(await total(), 2, "deleted count still consumes capacity");
  await db
    .prepare(
      "CREATE TRIGGER reject_cap BEFORE UPDATE ON employer_posting_day_caps WHEN NEW.n > OLD.n BEGIN SELECT RAISE(ABORT, 'synthetic cap failure'); END",
    )
    .run();
  eq(await restarted.count(event(), "192.0.2.150"), false, "second write failure");
  eq(await total(), 2, "failed batch cannot reserve capacity");
  eq(
    await db.prepare("SELECT n FROM employer_posting_counts WHERE day = '2026-11-16'").first("n"),
    1,
    "failed batch rolls back company increment",
  );
  await db.prepare("DROP TRIGGER reject_cap").run();
  eq(await restarted.count(event(), "192.0.2.150"), false, "error disables instance");
  eq(await restarted.cleanup(), true, "recover through successful cleanup");
  let ambiguous = false;
  const uncertain = make({
    prepare: (sql) => db.prepare(sql),
    batch: async (statements) => {
      const result = await db.batch(statements);
      if (ambiguous === "non-success") return result.map((item) => ({ ...item, success: false }));
      if (ambiguous) throw new Error("synthetic lost response after commit");
      return result;
    },
  });
  eq(await uncertain.cleanup(), true, "ambiguous response setup");
  ambiguous = true;
  eq(await uncertain.count(event(), "192.0.2.150"), false, "ambiguous response is not replayed");
  eq(await total(), 3, "committed cap survives lost response");
  eq(await uncertain.count(event(), "192.0.2.150"), false, "uncertain instance remains disabled");
  ambiguous = "non-success";
  eq(await uncertain.cleanup(), false, "non-success cleanup result stays disabled");
  ambiguous = false;
  eq(await uncertain.cleanup(), true, "non-success recovery");
  ambiguous = "non-success";
  eq(await uncertain.count(event(), "192.0.2.150"), false, "non-success count result");
  eq(await total(), 4, "non-success response cannot undo committed transaction");
  ambiguous = false;
  eq(await uncertain.count(event(), "192.0.2.150"), false, "non-success count disables readiness");
  await db.prepare("UPDATE employer_posting_day_caps SET n = 50000").run();
  await db.prepare("DELETE FROM employer_posting_counts WHERE day = '2026-11-16'").run();
  eq(await restarted.cleanup(), true, "full active cap survives cleanup");
  eq(
    await restarted.count(event(), "192.0.2.151"),
    false,
    "owner deletion cannot reopen overall cap",
  );
  eq(await total(), 50000, "active ceiling retained");
  time = new Date("2026-11-17T00:00:00Z");
  eq(await restarted.count(event(), "192.0.2.151"), false, "UTC rollover starts disabled");
  await db.prepare("INSERT INTO employer_posting_counts VALUES ('2026-01-01', 'acme', 1)").run();
  await db
    .prepare(
      "CREATE TRIGGER reject_cap_cleanup BEFORE DELETE ON employer_posting_day_caps BEGIN SELECT RAISE(ABORT, 'synthetic retention failure'); END",
    )
    .run();
  eq(await restarted.cleanup(), false, "partial retention failure disables collection");
  eq(
    await db.prepare("SELECT n FROM employer_posting_counts WHERE day = '2026-01-01'").first("n"),
    1,
    "failed cleanup rolls back earlier deletion",
  );
  await db.prepare("DROP TRIGGER reject_cap_cleanup").run();
  eq(await restarted.cleanup(), true, "next day cleanup");
  eq(
    (await db.prepare("SELECT * FROM employer_posting_day_caps").all()).results,
    [{ day: "2026-11-17", n: 0 }],
    "past cap rows purged, not historical rollups",
  );
  // A delayed previous-day cleanup must not recreate a purged cap after the new day exists.
  const stale = createEmployerPostingCounter({
    db,
    keys: ["acme"],
    now: () => new Date("2026-11-16T23:59:59Z"),
  });
  eq(await stale.cleanup(), false, "past-day initialization cannot supersede a later cap");
  eq(
    (await db.prepare("SELECT day FROM employer_posting_day_caps").all()).results,
    [{ day: "2026-11-17" }],
    "no stale cap resurrection",
  );
  await db.prepare("DROP TABLE employer_posting_day_caps").run();
  eq(await restarted.count(event(), "192.0.2.151"), false, "missing cap storage fails closed");
  return "bootstrap, restart, deletion, rollback, ambiguity and UTC passed";
}

// Actual local D1 metadata, not elapsed-time or production-traffic estimates.
export async function employerDayCapReads(db) {
  await db.prepare("DROP TABLE IF EXISTS employer_posting_counts").run();
  await db.prepare("DROP TABLE IF EXISTS employer_posting_day_caps").run();
  await db.prepare(EMPLOYER_COUNT_SCHEMA).run();
  await db.prepare(EMPLOYER_DAY_CAP_SCHEMA).run();
  const measurements = [];
  for (const size of [8, 10000]) {
    await db.prepare("DELETE FROM employer_posting_counts").run();
    await db.prepare("DELETE FROM employer_posting_day_caps").run();
    await db
      .prepare(
        `WITH RECURSIVE seq(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM seq WHERE x+1 < ?)
      INSERT INTO employer_posting_counts SELECT '2026-11-20', 'k'||x, 1 FROM seq`,
      )
      .bind(size)
      .run();
    await db
      .prepare("INSERT INTO employer_posting_day_caps VALUES ('2026-11-20', ?)")
      .bind(size)
      .run();
    let measured, cleanupWrites;
    const observed = {
      prepare: (sql) => db.prepare(sql),
      batch: async (statements) => {
        const results = await db.batch(statements);
        if (statements.length === 2)
          measured = {
            reads: results.reduce((n, result) => n + result.meta.rows_read, 0),
            writes: results.reduce((n, result) => n + result.meta.rows_written, 0),
          };
        else cleanupWrites = results.reduce((n, result) => n + result.meta.rows_written, 0);
        return results;
      },
    };
    const core = createEmployerPostingCounter({
      db: observed,
      keys: Array.from({ length: size }, (_, i) => `k${i}`),
      now: () => new Date("2026-11-20T12:00:00Z"),
    });
    eq(await core.cleanup(), true, "measured core ready");
    const accepted = [];
    for (let i = 0; i < 10; i++) {
      eq(
        await core.count(event("k0"), `192.0.2.${size === 8 ? 180 : 181}`),
        true,
        "measured increment",
      );
      accepted.push(measured);
    }
    // Frozen #227's statement in the same runtime/data fixture, solely as a comparison.
    const baseline = await db
      .prepare(
        `INSERT INTO employer_posting_counts(day, company, n)
      SELECT ?, ?, 1
      WHERE COALESCE((SELECT SUM(n) FROM employer_posting_counts WHERE day = ?), 0) < 50000
        AND COALESCE((SELECT n FROM employer_posting_counts WHERE day = ? AND company = ?), 0) < 1000
      ON CONFLICT(day, company) DO UPDATE SET n = n + 1 WHERE n < 1000`,
      )
      .bind("2026-11-20", "k0", "2026-11-20", "2026-11-20", "k0")
      .run();
    await db.prepare("UPDATE employer_posting_day_caps SET n = n + 1").run();
    await db.prepare("UPDATE employer_posting_day_caps SET n = 50000").run();
    eq(await core.count(event("k0"), "192.0.2.182"), false, "measured global rejection");
    const globalReject = measured;
    await db
      .prepare("UPDATE employer_posting_day_caps SET n = ?")
      .bind(size + 999)
      .run();
    await db.prepare("UPDATE employer_posting_counts SET n = 1000 WHERE company = 'k0'").run();
    eq(await core.count(event("k0"), "192.0.2.182"), false, "measured company rejection");
    measurements.push({
      keys: size,
      accepted,
      globalReject,
      companyReject: measured,
      cleanupWrites,
      baseline: { reads: baseline.meta.rows_read, writes: baseline.meta.rows_written },
    });
  }
  return measurements;
}

export function employerBudgetScenario() {
  let expire, delay;
  const expiring = createEmployerMinuteBudget(
    (fn, ms) => {
      expire = fn;
      delay = ms;
    },
    () => {},
  );
  const instant = new Date("2026-11-10T23:59:59Z");
  for (let i = 0; i < 30; i++) eq(expiring("192.0.2.1", instant), true, "expiry setup");
  eq(delay, 1000, "expiry scheduled at UTC minute boundary");
  expire();
  eq(expiring("192.0.2.1", instant), true, "timer removes idle address entries");
  const allow = createEmployerMinuteBudget(),
    other = createEmployerMinuteBudget();
  const now = new Date("2026-11-10T23:59:59Z");
  for (let i = 0; i < 30; i++) eq(allow("192.0.2.1", now), true, "address allowance");
  eq(allow("192.0.2.1", now), false, "address cap");
  eq(other("192.0.2.1", now), true, "independent instance");
  for (let i = 1; i < 2000; i++)
    eq(allow(`2001:db8:${i.toString(16)}::1`, now), true, "bounded map accepts capacity");
  eq(allow("192.0.2.2", now), false, "full map rejects new addresses");
  eq(allow("2001:db8:1::1", now), true, "existing entry retains allowance");
  for (const address of ["", null, "x".repeat(100), "company.example"])
    eq(allow(address, now), false, "missing/invalid address");
  eq(allow("192.0.2.2", new Date(NaN)), false, "invalid clock");
  eq(allow("192.0.2.2", new Date("2026-11-11T00:00:00Z")), true, "UTC minute resets capacity");
}
