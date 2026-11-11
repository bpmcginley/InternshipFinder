import test from "node:test";
import {
  followMatchingScopes,
  followMatchingWatermarks,
  followMatchingValidation,
} from "../test-support/follow-matching.js";
test("follow matching respects approved scopes and deduplicates", followMatchingScopes);
test("follow matching uses strict authoritative UTC watermarks", followMatchingWatermarks);
test("invalid or oversized matching input never proposes advancement", followMatchingValidation);
