import test from "node:test";
import { fakeD1 } from "./helpers.js";
import { purchasedAllowanceProjection } from "../test-support/purchased-allowance.js";

test("signed-in purchased allowance projection", () => purchasedAllowanceProjection(fakeD1()));
