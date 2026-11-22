import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/follow-management-route.js";
for (const [name, scenario] of Object.entries(scenarios)) test(name, () => scenario(fakeD1()));
