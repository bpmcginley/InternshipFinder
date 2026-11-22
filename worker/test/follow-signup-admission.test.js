import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/follow-signup-admission.js";

for (const [name, scenario] of Object.entries(scenarios))
  test(`follow signup admission: ${name}`, () => scenario(fakeD1()));
