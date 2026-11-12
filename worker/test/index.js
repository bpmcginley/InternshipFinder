import "./employer-posting-runtime.test.js";
import "./employer-retention.test.js";
// Lets `node --test worker/test/` run the whole folder (Node resolves a directory to index.js).
import "./auth.test.js";
import "./billing.test.js";
import "./billing-safety.test.js";
// 2026-10-23: audit event regressions must be included by npm test's directory entry point.
import "./billing-audit-events.test.js";
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
import "./order-mail.test.js";
import "./orders.test.js";
import "./social-video.test.js";
// 2026-10-23: directory runs resolve this entry point; new sprint regressions must run in CI too.
import "./employer-funnel.test.js";
import "./employer-metrics.test.js";
import "./employer-metrics-response.test.js";
import "./employer-posting-report.test.js";
import "./campaign-reports.test.js";
import "./employer-revenue-cron.test.js";

// 2026-10-23: include atomic checkout-settlement regressions in the directory CI entry point (W3).
import "./settlement-race.test.js";
// Route documentation and client completeness are checked without changing runtime routing.
import "./api-contract.test.js";

import "./follows.test.js";
import "./follow-management.test.js";
import "./follow-outbox.test.js";
import "./follow-retention.test.js";
import "./follow-unsubscribe.test.js";
import "./follow-unsubscribe-endpoint.test.js";
import "./follow-mail.test.js";
import "./follow-request-deletion.test.js";
import "./follow-matching.test.js";
import "./follow-progress.test.js";
import "./follow-enqueue.test.js";
import "./follow-send-budget.test.js";
import "./follow-budgeted-attempt.test.js";
import "./follow-finalization.test.js";
import "./follow-archive-reader.test.js";
import "./follow-archive-enqueue.test.js";
import "./follow-digest-delivery.test.js";
import "./follow-delivery-tick.test.js";
import "./follow-checkpoint-r2.test.js";
import "./follow-checkpoint-r2-native.test.js";

import "./topup-ledger.test.js";
import "./topup-decisions.test.js";
import "./topup-reconciliation.test.js";
import "./topup-allocation.test.js";
import "./topup-checkout.test.js";
import "./topup-stripe.test.js";
import "./topup-payment-evidence.test.js";
import "./topup-reversal-evidence.test.js";
import "./topup-first-settlement.test.js";
import "./topup-checkout-expiry.test.js";
import "./topup-session-reservation.test.js";
import "./topup-account-deletion.test.js";
import "./topup-attempt-recovery.test.js";
import "./topup-payment-bounds.test.js";
import "./topup-purchase-recovery.test.js";
import "./topup-checkout-bounds.test.js";
import "./session-copy-fence.test.js";
import "./topup-session-copy-integration.test.js";
import "./topup-checkout-service.test.js";
import "./topup-checkout-http.test.js";
import "./topup-checkout-route.test.js";

import "./employer-catalog-cache.test.js";
import "./employer-posting-counts.test.js";
import "./employer-request-safe.test.js";

import "./funded-run-admission.test.js";
import "./funded-run-callbacks.test.js";
import "./funded-run-sibling.test.js";
import "./funded-purchase.test.js";
import "./funded-provider.test.js";
import "./ai-lifecycle.test.js";

import "./topup-retention.test.js";
import "./topup-retirement.test.js";

import "./topup-webhook.test.js";
import "./purchased-allowance.test.js";
