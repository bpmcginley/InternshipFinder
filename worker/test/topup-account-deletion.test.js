import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/topup-account-deletion.js";
for (const scenario of Object.values(scenarios)) test(scenario.name, () => scenario(fakeD1()));
