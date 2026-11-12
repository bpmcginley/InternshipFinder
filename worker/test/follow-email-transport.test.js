import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/follow-email-transport.js";
for (const [name, scenario] of Object.entries(scenarios))
  test(`Follow email transport: ${name}`, () => scenario(fakeD1()));
