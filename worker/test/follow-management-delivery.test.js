import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/follow-management-delivery.js";
for (const [name, scenario] of Object.entries(scenarios))
  if (!["seed", "config", "presentation", "buildLinks"].includes(name))
    test(`management delivery: ${name}`, () => scenario(fakeD1()));
