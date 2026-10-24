import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { settlementRace } from "../test-support/settlement-race.js";

it("actual D1 atomically rolls back and races checkout drafts without orphans, then approves (W3)", async () => {
  await env.DB.batch(env.TEST_SCHEMA_SQL.map(s => env.DB.prepare(s)));
  expect(await settlementRace(env.DB, "o-0000000000000a02")).toEqual({
    rollbackRejected: true, afterRollback: 0, rollbackLogs: 0, placements: 1, orphaned: 0, logs: 1, approval: 200, approved: "approved",
  });
});
