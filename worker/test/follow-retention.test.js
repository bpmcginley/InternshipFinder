import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/follow-retention.js";

for (const [name, scenario] of Object.entries(scenarios)) {
  test(`follow retention: ${name}`, () => scenario(fakeD1()));
}
