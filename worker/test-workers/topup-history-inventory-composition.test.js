import { it } from "vitest";
import * as scenarios from "../test-support/topup-history-inventory-composition.js";
for (const [name, scenario] of Object.entries(scenarios))
  it(`native inventory composition: ${name}`, scenario);
