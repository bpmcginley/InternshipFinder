import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/topup-history-traversal.js";
for (const [name, scenario] of Object.entries(scenarios))
  test(`history traversal: ${name}`, () => scenario(fakeD1()));
