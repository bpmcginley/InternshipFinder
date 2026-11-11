import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { readEmployerPostingReport } from "../src/employer-posting-report.js";
import { EMPLOYER_COUNT_SCHEMA } from "../test-support/employer-posting-counts.js";
import { employerPostingReportScenario } from "../test-support/employer-posting-report.js";

it("reads only bounded company/day aggregates from actual local D1", async () => {
  await employerPostingReportScenario(
    env.DB,
    (actual, expected) => expect(actual).toEqual(expected),
    (run) => expect(run()).rejects.toThrow(RangeError),
  );
});

it("seeks directly to a deep cursor in the company/day index", async () => {
  const db = env.MIGRATION_DB;
  await db.prepare(EMPLOYER_COUNT_SCHEMA).run();
  await db
    .prepare(
      "WITH RECURSIVE seq(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM seq WHERE x < 9999) " +
        "INSERT INTO employer_posting_counts SELECT '2026-11-10', printf('key-%05d', x), 1 FROM seq",
    )
    .run();
  let reads;
  const measured = {
    prepare(sql) {
      return {
        bind(...params) {
          const statement = db.prepare(sql).bind(...params);
          return {
            async all() {
              const result = await statement.all();
              reads = result.meta.rows_read;
              return result;
            },
          };
        },
      };
    },
  };
  const page = await readEmployerPostingReport(measured, 1, new Date("2026-11-11T00:00:00Z"), {
    after: {
      start: "2026-11-10",
      end_exclusive: "2026-11-11",
      day: "2026-11-10",
      company: "key-09990",
    },
    limit: 3,
  });
  expect(page.rows.map(({ company }) => company)).toEqual(["key-09991", "key-09992", "key-09993"]);
  expect(page.next.company).toBe("key-09993");
  expect(reads).toBeLessThanOrEqual(8);
});
