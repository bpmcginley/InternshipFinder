// Self-serve paid listing orders (added 2026-10-19). The design, the reasons and how to turn it on:
// worker/ORDERS.md. Contract: API.md "Paid listing orders".
//
// An employer picks 1 or 3 of its open roles on internscout.org/employers/buy/, confirms a work email,
// pays through Stripe Checkout (or uses a pilot code) and Bruce makes one decision per order from a
// signed link in his email: Approve or Refuse. Approving drives the same placement steps Bruce runs by
// hand (placements.js: update, check, on), so every rule there still holds and every step is logged.
//
// What this file adds and nothing else does:
// - the role index check: a role qualifies only if the site's own role index lists it as open today,
//   read from SITE_URL, so a buyer can't name a role, link or field we don't list;
// - the per-field cap (FIELD_CAP paid roles at once per field tag) instead of any bidding;
// - the email link (a random token, stored only as its SHA-256), and the emails themselves (mail.js);
// - the Stripe calls for a one-off payment, a refund and a credit (billing.js's request helper);
// - the daily cron: dropping unconfirmed orders, resending review emails, closing roles that are gone
//   and the credit-or-refund offer for their unused days.
//
// Off until ordersOn(env). While off every /employer/* route answers 404, except GET /employer/config,
// which says enabled: false so the buy page can say buying on the site is not open yet.
export { listOrders } from "./orders/admin.js";
export { PILOT_MAX, createPilotCode } from "./orders/pilot.js";
export { readShard, shardOf } from "./orders/roles.js";
export { availability, notePlacementFields } from "./orders/capacity.js";
export { CREDIT_DEFAULT_DAYS, DAYS, FIELD_CAP, MAX_ORDER_BYTES, MAX_START_DAYS, PRICES, TERMS_BOX, TERMS_VERSION,
  UNVERIFIED_DAYS } from "./orders/shared.js";
export { TERMS_ARCHIVE, reviewSig } from "./orders/templates.js";
export { listingEvent } from "./orders/settlement.js";
export { CLOSE_REASONS, dropUnverifiedOrders, ordersCron } from "./orders/cron.js";
export { chooseCredit, creditInfo } from "./orders/refunds.js";
export { MAX_FORM_BYTES, reviewDecision, reviewPage } from "./orders/review.js";
export { ALL_PER_DAY, PER_ADDRESS_PER_DAY, TOKEN_HOURS, WEBMAIL, checkoutForm, confirmOrder, takeOrder } from "./orders/checkout.js";
export { newToken, orderConfig, ordersOn, requireOrders, tokenHash } from "./orders/access.js";
