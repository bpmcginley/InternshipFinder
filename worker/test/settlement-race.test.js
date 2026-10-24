import test from "node:test";
import assert from "node:assert/strict";
import { fakeD1 } from "./helpers.js";
import { settlementRace } from "../test-support/settlement-race.js";

test("checkout settlement is atomic and idempotent under concurrent events, then approves (W3)", async () => {
  assert.deepEqual(await settlementRace(fakeD1(), "o-0000000000000a01"), {
    rollbackRejected: true, afterRollback: 0, rollbackLogs: 0, placements: 1, orphaned: 0, logs: 1, approval: 200, approved: "approved",
  });
});
