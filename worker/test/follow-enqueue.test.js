import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/follow-enqueue.js";
for (const [name, scenario] of Object.entries(scenarios)) {
  test(`follow enqueue: ${name}`, () => scenario(fakeD1(), assert.deepEqual, assert.rejects));
}
test("pending migration is mirrored and enqueue is unwired", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  assert.ok(read("../schema.sql").includes(read("../migrations/0010_follow_pending_progress.sql")));
  assert.doesNotMatch(read("../src/index.js"), /follow-enqueue/);
});
