import { it } from "vitest";
import {
  followMatchingScopes,
  followMatchingWatermarks,
  followMatchingValidation,
} from "../test-support/follow-matching.js";
it("follow scopes and deduplication in Workers", followMatchingScopes);
it("strict UTC follow watermarks in Workers", followMatchingWatermarks);
it("invalid matching snapshots cannot advance in Workers", followMatchingValidation);
