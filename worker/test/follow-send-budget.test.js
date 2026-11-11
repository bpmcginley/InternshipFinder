import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/follow-send-budget.js";

for (const [name, scenario] of Object.entries(scenarios)) {
  test(`follow send budget: ${name}`, () => scenario(fakeD1()));
}

test("send budget migration is mirrored and budget remains unwired", () => {
  const read = (path) =>
    readFileSync(new URL(path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  assert.ok(read("../schema.sql").includes(read("../migrations/0016_follow_send_budget.sql")));
  for (const file of ["index", "mail", "follow-outbox"])
    assert.doesNotMatch(read(`../src/${file}.js`), /follow-send-budget/);
});
