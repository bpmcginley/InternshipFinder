import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/follow-budgeted-attempt.js";

for (const [name, scenario] of Object.entries(scenarios))
  test(`follow digest budget: ${name}`, () => scenario(fakeD1()));

test("budgeted digest claim is detached from production entry and transport", () => {
  for (const file of ["index", "mail", "follow-mail"]) {
    const path = new URL(`../src/${file}.js`, import.meta.url);
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /beginBudgetedFollowSnapshotAttempt|follow-outbox|follow-send-budget/,
    );
  }
});
