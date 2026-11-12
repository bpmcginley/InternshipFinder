import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/follow-management-request.js";

for (const [name, scenario] of Object.entries(scenarios))
  test(`management request: ${name}`, () => scenario(fakeD1()));
