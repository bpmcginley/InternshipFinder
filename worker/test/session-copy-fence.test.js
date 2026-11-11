import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/session-copy-fence.js";
for (const scenario of Object.values(scenarios)) test(scenario.name, () => scenario(fakeD1()));
