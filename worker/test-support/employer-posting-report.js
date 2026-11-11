import { readEmployerPostingReport } from "../src/employer-posting-report.js";
import { EMPLOYER_COUNT_SCHEMA, EMPLOYER_DAY_CAP_SCHEMA } from "./employer-posting-counts.js";

export async function employerPostingReportScenario(db, equal, rejects) {
  const now = new Date("2026-11-11T23:59:59Z");
  await db.batch([EMPLOYER_COUNT_SCHEMA, EMPLOYER_DAY_CAP_SCHEMA].map((sql) => db.prepare(sql)));
  const fixtures = [
    ["2026-08-12", "expired", 1],
    ["2026-08-13", "acme", 2],
    ["2026-11-09", "équipe", 3],
    ["2026-11-09", "zed", 4],
    ["2026-11-09", "alpha", 5],
    ["2026-11-10", "acme", 6],
    ["2026-11-11", "today", 7],
    ["2026-11-12", "future", 8],
  ];
  await db.batch([
    ...fixtures.map((row) =>
      db
        .prepare("INSERT INTO employer_posting_counts (day, company, n) VALUES (?, ?, ?)")
        .bind(...row),
    ),
    db.prepare("INSERT INTO employer_posting_day_caps (day, n) VALUES ('2026-11-10', 40)"),
  ]);
  const first = await readEmployerPostingReport(db, 90, now, { limit: 2 });
  const second = await readEmployerPostingReport(db, 90, now, { after: first.next, limit: 2 });
  const third = await readEmployerPostingReport(db, 90, now, { after: second.next, limit: 2 });
  equal(first.start, "2026-08-13");
  equal(first.end_exclusive, "2026-11-11");
  equal(first.next, {
    start: first.start,
    end_exclusive: first.end_exclusive,
    day: "2026-11-09",
    company: "alpha",
  });
  equal(third.next, null);
  equal(
    [...first.rows, ...second.rows, ...third.rows],
    [fixtures[1], fixtures[4], fixtures[3], fixtures[2], fixtures[5]].map(([day, company, n]) => ({
      day,
      company,
      n,
    })),
  );
  equal(await readEmployerPostingReport(db, 1, now), {
    start: "2026-11-10",
    end_exclusive: "2026-11-11",
    rows: [{ day: "2026-11-10", company: "acme", n: 6 }],
    next: null,
  });
  const noRows = await readEmployerPostingReport(db, 1, new Date("2026-08-12T00:00:00Z"));
  equal(noRows.rows, []);
  equal(noRows.next, null);
  await rejects(() => readEmployerPostingReport(db, 91, now));
  await rejects(() => readEmployerPostingReport(db, 90, now, { limit: 1001 }));
  await rejects(() =>
    readEmployerPostingReport(db, 90, now, { after: { ...first.next, day: "2026-09-31" } }),
  );
  await rejects(() =>
    readEmployerPostingReport(db, 90, now, { after: { ...first.next, company: "é".repeat(101) } }),
  );
  await rejects(() =>
    readEmployerPostingReport(db, 90, new Date("2026-11-12T00:00:00Z"), { after: first.next }),
  );
  equal(
    await db.prepare("SELECT COUNT(*) AS n FROM employer_posting_counts").first("n"),
    fixtures.length,
  );
  equal(await db.prepare("SELECT n FROM employer_posting_day_caps").first("n"), 40);
}
