import test from "node:test";
import { fakeD1 } from "./helpers.js";
import {
  allocationLifecycle,
  allocationCurrentState,
  allocationRacesAndRollback,
} from "../test-support/topup-allocation.js";

for (const scenario of [allocationLifecycle, allocationCurrentState, allocationRacesAndRollback]) {
  test(scenario.name, () => scenario(fakeD1()));
}
