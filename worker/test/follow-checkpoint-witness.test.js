import test from "node:test";
import * as cases from "../test-support/follow-checkpoint-witness.js";

for (const [name, run] of Object.entries(cases)) test(name, run);
