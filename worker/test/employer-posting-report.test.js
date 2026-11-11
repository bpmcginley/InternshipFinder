import assert from "node:assert/strict";
import test from "node:test";
import { employerPostingReportScenario } from "../test-support/employer-posting-report.js";
import { fakeD1 } from "./helpers.js";

test("employer posting reports use completed retained days and bounded keyset pages", async () => {
  await employerPostingReportScenario(fakeD1(), assert.deepEqual, (run) =>
    assert.rejects(run, RangeError),
  );
});
