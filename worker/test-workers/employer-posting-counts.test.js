import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
  employerBudgetScenario,
  employerCounterScenario,
  employerDayCapScenario,
  employerDayCapReads,
} from "../test-support/employer-posting-counts.js";
import { EMPLOYER_POSTING_EVENT } from "../src/employer-posting-counts.js";
import { handle } from "../src/index.js";

it("isolates and bounds the employer minute budget", employerBudgetScenario);
it("enforces employer caps concurrently in actual local D1", async () => {
  expect(await employerCounterScenario(env.DB)).toBe(
    "validation, UTC, atomic caps and retention passed",
  );
});
it("local D1 preserves the day cap across deletion, failure and UTC rollover", async () => {
  expect(await employerDayCapScenario(env.MIGRATION_DB)).toBe(
    "bootstrap, restart, deletion, rollback, ambiguity and UTC passed",
  );
});
it("leaves the current production hit route unwired", async () => {
  const db = env.LEGACY_DB;
  await db.batch(env.TEST_SCHEMA_SQL.map((s) => db.prepare(s)));
  const response = await handle(
    new Request("https://api.test/hit", {
      method: "POST",
      headers: {
        Origin: "https://internscout.org",
        "User-Agent": "Mozilla/5.0",
        "CF-Connecting-IP": "192.0.2.25",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ e: EMPLOYER_POSTING_EVENT, c: "acme" }),
    }),
    { ...env, DB: db },
    { waitUntil: () => {} },
  );
  expect(response.status).toBe(204);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM event_counts").first("n")).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('employer_posting_counts', 'employer_posting_day_caps')",
      )
      .first("n"),
  ).toBe(0);
});
it("keeps actual local D1 reads constant at the 10000-key bound", async () => {
  const measured = await employerDayCapReads(env.DB);
  expect(measured).toEqual(
    [8, 10000].map((keys) => ({
      keys,
      accepted: Array(10).fill({ reads: 3, writes: 2 }),
      globalReject: { reads: 2, writes: 0 },
      companyReject: { reads: 3, writes: 0 },
      cleanupWrites: 0,
      baseline: { reads: keys + 3, writes: 1 },
    })),
  );
});
