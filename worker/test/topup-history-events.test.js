import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/topup-history-events.js";
for (const [name, scenario] of Object.entries(scenarios))
  test(`history events: ${name}`, () => scenario(fakeD1()));
