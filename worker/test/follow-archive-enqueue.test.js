import assert from "node:assert/strict";
import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/follow-archive-enqueue.js";

for (const [name, scenario] of Object.entries(scenarios)) {
  test(`archive-qualified enqueue: ${name}`, () => scenario(fakeD1(), assert.deepEqual));
}
