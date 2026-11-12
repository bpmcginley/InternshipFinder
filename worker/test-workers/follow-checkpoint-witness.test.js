import { it } from "vitest";
import * as cases from "../test-support/follow-checkpoint-witness.js";

for (const [name, run] of Object.entries(cases)) it(name, run);
