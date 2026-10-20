// Lets `node --test worker/test/` run the whole folder (Node resolves a directory to index.js).
import "./auth.test.js";
import "./billing.test.js";
import "./ai.test.js";
import "./demand.test.js";
import "./gemini.test.js";
import "./limits.test.js";
// referral.test.js was missing here, so `node --test test/` (npm test) never ran the referral tests.
import "./referral.test.js";
import "./session.test.js";
import "./profile.test.js";
// The site build's record of each live paid listing (2026-10-14).
import "./placement-runs.test.js";
import "./visits.test.js";
import "./clock.test.js";
import "./leads.test.js";
import "./placements.test.js";
import "./placement-script.test.js";
import "./placement-counts.test.js";
// Paid listings bought on the site (2026-10-19).
import "./mail.test.js";
import "./orders.test.js";
