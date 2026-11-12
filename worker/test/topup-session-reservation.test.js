import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/topup-session-reservation.js";
for (const scenario of Object.values(scenarios)) test(scenario.name, () => scenario(fakeD1()));
