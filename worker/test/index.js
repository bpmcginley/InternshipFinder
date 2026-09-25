// Lets `node --test worker/test/` run the whole folder (Node resolves a directory to index.js).
import "./auth.test.js";
import "./billing.test.js";
import "./ai.test.js";
import "./demand.test.js";
import "./gemini.test.js";
import "./limits.test.js";
// referral.test.js was missing here, so `node --test test/` (npm test) never ran the referral tests.
import "./referral.test.js";
