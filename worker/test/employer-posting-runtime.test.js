import { test } from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/employer-posting-runtime.js";
for (const [name, scenario] of Object.entries(scenarios))
  test(`employer route: ${name}`, () => scenario(fakeD1()));
