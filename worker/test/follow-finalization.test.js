import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/follow-finalization.js";
for (const [name, scenario] of Object.entries(scenarios))
  test(`follow finalization: ${name}`, () => scenario(fakeD1(), assert.deepEqual, assert.rejects));
test("finalization migration mirrors the legacy schema and strict attempt is unwired", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const legacy = read("../schema.sql");
  const original = read("../migrations/0012_follow_attempt_progress.sql");
  const replacement = read("../migrations/0032_follow_finalize_attempt_cost.sql");
  const trigger = /^CREATE TRIGGER (?:IF NOT EXISTS )?follow_finalize_attempt\b[\s\S]*?^END;$/m;
  const updatedTrigger = replacement.match(trigger)?.[0];
  assert.ok(updatedTrigger);
  assert.match(replacement, /^DROP TRIGGER IF EXISTS follow_finalize_attempt;$/m);
  assert.ok(
    legacy.includes(
      original.replace(
        trigger,
        updatedTrigger.replace("CREATE TRIGGER ", "CREATE TRIGGER IF NOT EXISTS "),
      ),
    ),
  );
  assert.doesNotMatch(read("../src/index.js"), /beginFollowSnapshotAttempt/);
});
