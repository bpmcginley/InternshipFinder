import {
  createEmployerMinuteBudget,
  createEmployerPostingCounter,
  EMPLOYER_POSTING_EVENT,
} from "../src/employer-posting-counts.js";

// Test-only schema: no production migration or shared baseline is changed.
export const EMPLOYER_COUNT_SCHEMA = `CREATE TABLE employer_posting_counts (
  day TEXT NOT NULL, company TEXT NOT NULL, n INTEGER NOT NULL CHECK(n BETWEEN 1 AND 1000),
  PRIMARY KEY(day, company)
)`;
const eq = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label);
};
const event = (c = "acme") => ({ e: EMPLOYER_POSTING_EVENT, c });

export async function employerCounterScenario(db) {
  await db.prepare(EMPLOYER_COUNT_SCHEMA).run();
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
  const companyRace = await Promise.all(
    Array.from({ length: 20 }, (_, i) => core.count(event(), `192.0.2.${i + 10}`)),
  );
  eq(companyRace.filter(Boolean).length, 2, "atomic per-company cap");
  eq((await rows())[0].n, 1000, "per-company ceiling");

  await db.prepare("DELETE FROM employer_posting_counts").run();
  const many = Array.from({ length: 70 }, (_, i) => `company${i}`);
  for (let i = 0; i < 50; i++)
    await db
      .prepare("INSERT INTO employer_posting_counts VALUES (?, ?, ?)")
      .bind("2026-11-11", many[i], i === 49 ? 998 : 1000)
      .run();
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

  await db.prepare("DELETE FROM employer_posting_counts").run();
  for (const day of ["2026-08-12", "2026-08-13", "2026-11-11"])
    await db.prepare("INSERT INTO employer_posting_counts VALUES (?, 'acme', 1)").bind(day).run();
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
    prepare: (sql) =>
      sql.startsWith("DELETE")
        ? {
            bind: () => ({
              run: () =>
                new Promise((resolve) => {
                  release = resolve;
                }),
            }),
          }
        : db.prepare(sql),
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
