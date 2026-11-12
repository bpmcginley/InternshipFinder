import test from "node:test";
import * as scenarios from "../test-support/topup-session-copy-integration.js";
import { fakeD1 } from "./helpers.js";

for (const scenario of Object.values(scenarios)) test(scenario.name, () => scenario(fakeD1()));
