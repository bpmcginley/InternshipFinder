import test from "node:test";
import "./follow-prepared-related.test.js";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/follow-digest-delivery.js";
for (const [name, scenario] of Object.entries(scenarios))
  test(`digest delivery: ${name}`, () => scenario(fakeD1()));
