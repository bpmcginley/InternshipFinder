import test from "node:test";
import * as scenarios from "../test-support/topup-history-inventory-composition.js";
for (const [name, scenario] of Object.entries(scenarios))
  test(`inventory composition: ${name}`, scenario);
