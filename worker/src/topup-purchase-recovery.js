// Dormant internal refresh of an existing purchase. No grant, provider write or route.
import { readTopupRevision, reconcileExistingTopup } from "./topup-reconciliation.js";
import { referenceHash } from "./topup-ledger.js";
import { readTopupPaymentEvidence } from "./topup-payment-evidence.js";
import { readTopupReversalEvidence } from "./topup-reversal-evidence.js";
const pending = () => ({ status: "pending" });

// Historical offer configuration is trusted input; no current-sales gate or browser evidence.
export async function readVerifiedTopupPurchase(db, env, paymentHash, originalOffer, fetchImpl) {
  if (typeof fetchImpl !== "function") return pending();
  let offer;
  try {
    offer = structuredClone(originalOffer);
  } catch {
    return pending();
  }
  if (typeof offer?.livemode !== "boolean") return pending();
  const config = { STRIPE_SECRET_KEY: env?.STRIPE_SECRET_KEY };
  // Read before BOTH provider phases. This is commit CAS, not a latest-start generation.
  const captured = await readTopupRevision(db, paymentHash);
  if (!captured) return { status: "unavailable" };
  const attempt = await db
    .prepare(
      "SELECT a.*, c.checkout_hash FROM topup_purchases p " +
        "JOIN topup_claims c ON c.payment_hash=p.payment_hash " +
        "JOIN topup_checkout_attempts a ON a.checkout_id=p.checkout_id " +
        "AND a.user_hash=p.user_hash AND a.offer_version=p.offer_version " +
        "AND a.units=p.granted AND a.currency=p.currency " +
        "WHERE p.payment_hash=? AND c.state='granted' AND a.state='settled'",
    )
    .bind(paymentHash)
    .first();
  if (!attempt) return { status: "unavailable" };
  const [paymentFingerprint, checkoutFingerprint] = await Promise.all([
    referenceHash("payment", offer.livemode, captured.payment_id),
    referenceHash("checkout", offer.livemode, captured.checkout_id),
  ]);
  if (
    paymentFingerprint !== paymentHash ||
    checkoutFingerprint !== attempt.checkout_hash ||
    attempt.checkout_id !== captured.checkout_id ||
    attempt.user_hash !== captured.user_hash
  )
    return pending();
  const get = (url, options) => {
    if (options?.method !== "GET" || options.body != null)
      throw new Error("Purchase refresh transport must be GET-only");
    return fetchImpl(url, options);
  };
  const payment = await readTopupPaymentEvidence(config, attempt, offer, get);
  if (
    payment.status !== "paid_evidence" ||
    payment.paymentId !== captured.payment_id ||
    payment.checkoutId !== captured.checkout_id ||
    payment.userHash !== captured.user_hash ||
    payment.capturedAmount !== captured.amount ||
    payment.currency !== captured.currency
  )
    return pending();
  const reversals = await readTopupReversalEvidence(config, payment, get);
  if (
    reversals.status !== "reversal_evidence" ||
    !["paymentId", "checkoutId", "chargeId", "livemode", "currency", "capturedAmount"].every(
      (key) => reversals[key] === payment[key],
    )
  )
    return pending();
  return { status: "verified", captured, reversals };
}

export async function recoverTopupPurchase(db, env, paymentHash, originalOffer, fetchImpl) {
  const evidence = await readVerifiedTopupPurchase(db, env, paymentHash, originalOffer, fetchImpl);
  if (evidence.status !== "verified") return evidence;
  const { captured, reversals } = evidence;
  // Committed prior flags/hold causes and current unused balances are read inside this helper.
  // First successful commit wins. A conflict needs a new capture AND new provider reads;
  // failed reads never advance the revision. Storage errors propagate, without retry.
  return reconcileExistingTopup(db, paymentHash, captured.revision, reversals);
}
