import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/follow-finalization.js";
for (const [name, scenario] of Object.entries(scenarios))
  test(`follow finalization: ${name}`, () => scenario(fakeD1(), assert.deepEqual, assert.rejects));
test("finalization migration mirrors the legacy schema and strict attempt is unwired", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  assert.ok(read("../schema.sql").includes(read("../migrations/0012_follow_attempt_progress.sql")));
  assert.doesNotMatch(read("../src/index.js"), /beginFollowSnapshotAttempt/);
});
