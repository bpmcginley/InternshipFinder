import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/follow-linked-request.js";
for (const [name, scenario] of Object.entries(scenarios))
  if (name !== "d1Reads")
    test(`scoped linking: ${name}`, () => scenario(scenarios.d1Reads(fakeD1())));
