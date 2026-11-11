// Dormant internal composition, not an HTTP handler. All transport is explicitly injected.
import { captureTopupSettlement, settleFirstTopup } from "./topup-first-settlement.js";
import { readTopupPaymentEvidence } from "./topup-payment-evidence.js";
import { readTopupReversalEvidence } from "./topup-reversal-evidence.js";
import { expireTopupCheckout } from "./topup-checkout-expiry.js";
const pending = () => ({ status: "pending" });

// originalOffer is trusted historical configuration. A candidate is a trusted recovery hint,
// not proof: the reader verifies its complete association. No discovery or automatic retry.
export async function recoverTopupAttempt(
  db,
  env,
  attemptId,
  originalOffer,
  fetchImpl,
  { candidateCheckoutId, clock = () => new Date(), beforeApply } = {},
) {
  if (typeof fetchImpl !== "function" || typeof clock !== "function") return pending();
  let offer;
  try {
    offer = structuredClone(originalOffer);
  } catch {
    return pending();
  }
  const config = { STRIPE_SECRET_KEY: env?.STRIPE_SECRET_KEY };
  // This durable fence precedes BOTH authoritative reads, including unsuccessful reads.
  const captured = await captureTopupSettlement(db, attemptId);
  if (!captured) return { status: "inactive" };
  const get = (url, options) => {
    if (options?.method !== "GET" || options.body != null)
      throw new Error("Recovery transport must be GET-only");
    return fetchImpl(url, options);
  };
  const payment = await readTopupPaymentEvidence(
    config,
    captured,
    offer,
    get,
    candidateCheckoutId ?? captured.checkout_id,
  );
  if (payment.status === "expired_evidence") {
    if (beforeApply && !(await beforeApply())) return pending();
    return expireTopupCheckout(db, captured, payment);
  }
  if (payment.status !== "paid_evidence") return pending();
  // The same payment object supplies charge/mode/amount identity to the reversal reader
  // and settlement. Neither HTTP claims nor a provisional reader disposition is accepted.
  const reversals = await readTopupReversalEvidence(config, payment, get);
  if (reversals.status !== "reversal_evidence") return pending();
  if (beforeApply && !(await beforeApply())) return pending();
  let now;
  try {
    const value = clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return pending();
    now = new Date(value.getTime());
  } catch {
    return pending();
  }
  // Storage errors propagate; a failed batch must not be reported as successful recovery.
  // Stale results are returned unchanged: a later caller must recapture AND reread.
  return settleFirstTopup(db, captured, payment, reversals, now);
}
