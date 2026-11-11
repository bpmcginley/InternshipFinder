import test from "node:test";
import { fakeD1 } from "./helpers.js";
import {
  checkoutReservation,
  checkoutAmbiguity,
  checkoutAssociation,
  checkoutAtomicity,
} from "../test-support/topup-checkout.js";
for (const scenario of [
  checkoutReservation,
  checkoutAmbiguity,
  checkoutAssociation,
  checkoutAtomicity,
]) {
  test(scenario.name, () => scenario(fakeD1()));
}
