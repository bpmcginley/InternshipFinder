// Dormant GET-only evidence. Paid evidence is NOT permission to grant or settle.
// Complete reversal snapshots, atomic settlement and account-deletion fences remain required.
import { stripe } from "./billing.js";
import { validTopupCheckoutId, validTopupOfferVersion } from "./topup-ledger.js";
const pending = () => ({ status: "pending" });
const ref = (value) => (typeof value === "string" ? value : value?.id);
const id = (value, prefix) =>
  typeof value === "string" && new RegExp("^" + prefix + "_[A-Za-z0-9_]{1,250}$").test(value);
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;

// attempt and originalOffer come from trusted storage/configuration, never browser claims.
// A candidate can recover a lost creation response, but its provider association must match.
export async function readTopupPaymentEvidence(
  env,
  attempt,
  originalOffer,
  fetchImpl,
  candidateCheckoutId = attempt?.checkout_id,
) {
  const a = { ...attempt },
    offer = { ...originalOffer };
  if (
    typeof env?.STRIPE_SECRET_KEY !== "string" ||
    !env.STRIPE_SECRET_KEY ||
    typeof fetchImpl !== "function" ||
    typeof a.id !== "string" ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(a.id || "") ||
    typeof a.user_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(a.user_hash) ||
    !["creating", "open", "settled", "expired"].includes(a.state) ||
    !validTopupOfferVersion(offer.version) ||
    a.offer_version !== offer.version ||
    !id(offer.priceId, "price") ||
    typeof offer.livemode !== "boolean" ||
    a.amount !== 300 ||
    offer.amount !== a.amount ||
    a.currency !== "usd" ||
    offer.currency !== a.currency ||
    a.units !== 25 ||
    offer.units !== a.units ||
    !validTopupCheckoutId(candidateCheckoutId) ||
    (a.checkout_id !== null && a.checkout_id !== candidateCheckoutId)
  )
    return pending();
  const config = { STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY };
  const get = (path) =>
    stripe(
      config,
      path,
      {},
      async (url, options) => {
        // Throw before billing's logger can include a private object path or provider error body.
        const response = await fetchImpl(url, { ...options, redirect: "error" });
        if (!response.ok) throw new Error("unavailable");
        return response;
      },
      null,
      "GET",
    );
  const expected = {
    kind: "autofill_topup",
    attempt_id: a.id,
    user_hash: a.user_hash,
    offer_version: a.offer_version,
    units: String(a.units),
  };
  const associated = (object) =>
    Object.entries(expected).every(([k, v]) => object?.metadata?.[k] === v);
  const sameMode = (object) =>
    object?.livemode === offer.livemode && object.currency === a.currency;
  const evidence = (status) => ({
    status,
    attemptId: a.id,
    checkoutId: candidateCheckoutId,
    userHash: a.user_hash,
    offerVersion: a.offer_version,
    offerAmount: a.amount,
    currency: a.currency,
    units: a.units,
    livemode: offer.livemode,
  });
  try {
    const session = await get(
      "checkout/sessions/" + encodeURIComponent(candidateCheckoutId) + "?expand[]=line_items",
    );
    const items = session?.line_items,
      item = items?.data?.[0],
      total = session?.total_details;
    if (
      session?.object !== "checkout.session" ||
      session.id !== candidateCheckoutId ||
      session.mode !== "payment" ||
      session.ui_mode !== "hosted_page" ||
      !sameMode(session) ||
      !associated(session) ||
      session.client_reference_id !== a.user_hash ||
      session.recovered_from !== null ||
      session.amount_subtotal !== a.amount ||
      items?.object !== "list" ||
      items.has_more !== false ||
      !Array.isArray(items.data) ||
      items.data.length !== 1 ||
      !item ||
      item.quantity !== 1 ||
      item.price?.id !== offer.priceId ||
      item.price.currency !== a.currency ||
      item.price.unit_amount !== a.amount ||
      item.price.tax_behavior !== "exclusive" ||
      item.currency !== a.currency ||
      item.amount_subtotal !== a.amount ||
      total?.amount_discount !== 0 ||
      total.amount_shipping !== 0 ||
      !nonnegative(total.amount_tax) ||
      !Number.isSafeInteger(session.amount_total) ||
      session.amount_total !== a.amount + total.amount_tax
    )
      return pending();
    const expired =
      session.status === "expired" && session.payment_status === "unpaid" && a.state !== "settled";
    const paid =
      session.status === "complete" && session.payment_status === "paid" && a.state !== "expired";
    if (!expired && !paid) return pending();
    if (expired && session.payment_intent === null) return evidence("expired_evidence");
    const paymentId = ref(session.payment_intent);
    if (!id(paymentId, "pi")) return pending();
    const intent = await get("payment_intents/" + encodeURIComponent(paymentId));
    if (
      intent?.object !== "payment_intent" ||
      intent.id !== paymentId ||
      !sameMode(intent) ||
      !associated(intent) ||
      intent.amount !== session.amount_total ||
      intent.amount_capturable !== 0 ||
      (expired
        ? intent.status !== "canceled" || intent.amount_received !== 0
        : intent.status !== "succeeded" || intent.amount_received !== session.amount_total)
    )
      return pending();
    if (expired && intent.latest_charge === null) return evidence("expired_evidence");
    const chargeId = ref(intent.latest_charge);
    if (!id(chargeId, "ch")) return pending();
    const charge = await get("charges/" + encodeURIComponent(chargeId));
    if (
      charge?.object !== "charge" ||
      charge.id !== chargeId ||
      !sameMode(charge) ||
      ref(charge.payment_intent) !== paymentId ||
      charge.amount !== session.amount_total
    )
      return pending();
    if (expired)
      return charge.status === "failed" &&
        charge.paid === false &&
        charge.captured === false &&
        charge.amount_captured === 0
        ? evidence("expired_evidence")
        : pending();
    if (
      charge.status !== "succeeded" ||
      charge.paid !== true ||
      charge.captured !== true ||
      charge.amount_captured !== session.amount_total
    )
      return pending();
    // Refunded/disputed payments may still have succeeded. This says nothing about spendability.
    return {
      ...evidence("paid_evidence"),
      paymentId,
      chargeId,
      capturedAmount: charge.amount_captured,
    };
  } catch {
    return pending();
  }
}
