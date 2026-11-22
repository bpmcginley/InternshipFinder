import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as cases from "../test-support/follow-prepared-related.js";
for (const [name, scenario] of Object.entries(cases)) test(name, () => scenario(fakeD1()));
