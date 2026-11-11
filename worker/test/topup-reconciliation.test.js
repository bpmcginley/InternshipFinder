import test from "node:test";
import { fakeD1 } from "./helpers.js";
import {
  reconciliationLifecycle,
  reconciliationRaces,
  reconciliationRollbackAndDeletion,
} from "../test-support/topup-reconciliation.js";

test("top-up reconciliation preserves lifecycle, isolation and zero-balance holds", () =>
  reconciliationLifecycle(fakeD1()));
test("top-up same-revision contenders cannot overwrite balances or hold causes", () =>
  reconciliationRaces(fakeD1()));
test("top-up reconciliation rolls back and refuses deletion resurrection", () =>
  reconciliationRollbackAndDeletion(fakeD1()));
