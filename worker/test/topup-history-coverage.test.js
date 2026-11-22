import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/topup-history-coverage.js";
for (const [name, scenario] of Object.entries(scenarios))
  test(`history coverage: ${name}`, () => scenario(fakeD1()));
