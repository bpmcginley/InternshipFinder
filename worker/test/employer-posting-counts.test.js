import test from "node:test";
import assert from "node:assert/strict";
import { fakeD1, setup } from "./helpers.js";
import {
  employerBudgetScenario,
  employerCachedCounterScenario,
  employerCounterScenario,
  employerDayCapScenario,
} from "../test-support/employer-posting-counts.js";
import { EMPLOYER_POSTING_EVENT } from "../src/employer-posting-counts.js";

// This frozen parent's fake batch lacks SELECT results. Adapt only this focused test,
// without changing the shared helper owned by the follow-lifecycle stack.
function counterDb() {
  const db = fakeD1();
  return {
    ...db,
    prepare(sql) {
      const wrap = (statement) => ({
        ...statement,
        bind: (...args) => wrap(statement.bind(...args)),
        run: () => (/^\s*SELECT\b/i.test(sql) ? statement.all() : statement.run()),
      });
      return wrap(db.prepare(sql));
    },
  };
}

test("isolated employer budget is bounded and independent", employerBudgetScenario);
test("employer aggregate core enforces caps and retention in SQLite", async () => {
  await employerCounterScenario(counterDb());
});
test("cached employer counter discards stale catalogs and admissions", async () => {
  await employerCachedCounterScenario(counterDb());
});
test("day cap survives restart/deletion and fails closed on ambiguous state", async () => {
  await employerDayCapScenario(counterDb());
});
test("current production hit route ignores the new event", async () => {
  const w = await setup();
  const res = await w.api("POST", "/hit", {
    body: { e: EMPLOYER_POSTING_EVENT, c: "acme" },
    headers: {
      Origin: "https://internscout.org",
      "User-Agent": "Mozilla/5.0",
      "CF-Connecting-IP": "192.0.2.25",
    },
  });
  assert.equal(res.status, 204);
  assert.deepEqual(w.db.dump().event_counts, []);
  assert.equal(
    await w.db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('employer_posting_counts', 'employer_posting_day_caps')",
      )
      .first("n"),
    0,
  );
});
