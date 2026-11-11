import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/follow-delivery-tick.js";
for (const [name, scenario] of Object.entries(scenarios))
  if (name !== "measureCandidateReads") test(`delivery tick: ${name}`, () => scenario(fakeD1()));
