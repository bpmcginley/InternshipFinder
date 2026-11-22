import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/topup-history-observation.js";
for (const [name, scenario] of Object.entries(scenarios))
  test(`history observation: ${name}`, () => scenario(fakeD1()));
