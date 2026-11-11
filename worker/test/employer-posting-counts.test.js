import test from "node:test";
import assert from "node:assert/strict";
import { fakeD1, setup } from "./helpers.js";
import {
  employerBudgetScenario,
  employerCounterScenario,
} from "../test-support/employer-posting-counts.js";
import { EMPLOYER_POSTING_EVENT } from "../src/employer-posting-counts.js";

test("isolated employer budget is bounded and independent", employerBudgetScenario);
test("employer aggregate core enforces caps and retention in SQLite", async () => {
  await employerCounterScenario(fakeD1());
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
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'employer_posting_counts'")
      .first("n"),
    0,
  );
});
