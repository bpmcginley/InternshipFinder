import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/topup-checkout-service.js";
for (const [name, scenario] of Object.entries(scenarios))
  test(`checkout service: ${name}`, () => scenario(fakeD1()));
