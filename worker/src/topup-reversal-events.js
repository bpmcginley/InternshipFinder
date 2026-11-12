// Dormant handoff for snapshot events returned by the existing signature verifier.
import { referenceHash, validTopupCheckoutId } from "./topup-ledger.js";
import { recoverTopupPurchase } from "./topup-purchase-recovery.js";

import { topupReversalObject } from "./topup-reversal-types.js";
import { observeVerifiedTopupEvent } from "./topup-history-events.js";
export { topupReversalObject } from "./topup-reversal-types.js";

// Keep malformed/accessor/sparse version lists from becoming valid during cloning.
export function snapshotTopupHistoryPolicy(policy) {
  if (policy?.enabled !== true) return null;
  const raw = policy.apiVersions,
    livemode = policy.livemode,
    versions = [];
  if (typeof livemode !== "boolean" || !Array.isArray(raw) || !raw.length || raw.length > 4)
    throw new Error("Invalid history policy");
  for (let i = 0; i < raw.length; i++) {
    const d = Object.getOwnPropertyDescriptor(raw, i);
    if (!d?.enumerable || !Object.hasOwn(d, "value") || typeof d.value !== "string")
      throw new Error("Invalid history policy");
    versions.push(d.value);
  }
  return Object.freeze({ enabled: true, livemode, apiVersions: Object.freeze(versions) });
}
const validId = (value, prefix) =>
  typeof value === "string" && new RegExp("^" + prefix + "_[A-Za-z0-9_]{1,250}$").test(value);
const pending = () => ({ status: "pending" });

// Trusted caller verifies the signature on the raw body first. Unclassified is not
// authorization for subscription/employer handling. No account-context discovery here.
export async function recoverVerifiedTopupReversalEvent({
  db,
  env,
  event,
  resolveOffer,
  fetchImpl,
  historyPolicy,
} = {}) {
  const expected = topupReversalObject(event?.type);
  if (!expected) return { status: "unclassified" };
  const object = event.data?.object;
  const livemode = event.livemode;
  if (
    event.object !== "event" ||
    !validId(event.id, "evt") ||
    typeof livemode !== "boolean" ||
    event.account != null ||
    event.context != null ||
    object?.object !== expected ||
    !validId(object.id, { refund: "re", charge: "ch", dispute: "du" }[expected]) ||
    (expected !== "refund" && object.livemode !== livemode) ||
    (object.livemode !== undefined && object.livemode !== livemode)
  )
    return pending();
  // Refund has no livemode attribute; its verified Event supplies the mode.
  const intent = object.payment_intent;
  const paymentId = typeof intent === "string" ? intent : intent?.id;
  if (
    !validId(paymentId, "pi") ||
    (typeof intent !== "string" &&
      (intent?.object !== "payment_intent" || intent.livemode !== livemode))
  )
    return pending();
  try {
    let history,
      invalidHistory = false;
    try {
      history = snapshotTopupHistoryPolicy(historyPolicy);
    } catch {
      invalidHistory = true;
    }
    const config = history
      ? Object.freeze({
          STRIPE_SECRET_KEY: env?.STRIPE_SECRET_KEY,
          STRIPE_PRICE_TOPUP: env?.STRIPE_PRICE_TOPUP,
        })
      : env;
    const observedEvent = history ? structuredClone(event) : null;
    const paymentHash = await referenceHash("payment", livemode, paymentId);
    const result = await db.batch([
      db
        .prepare(
          "SELECT c.state,c.checkout_hash,p.payment_id,p.checkout_id,p.offer_version " +
            "FROM topup_claims c LEFT JOIN topup_purchases p ON p.payment_hash=c.payment_hash " +
            "WHERE c.payment_hash=? LIMIT 2",
        )
        .bind(paymentHash),
    ]);
    if (
      result.length !== 1 ||
      result[0]?.success !== true ||
      !Array.isArray(result[0].results) ||
      result[0].results.length > 1
    )
      return pending();
    const [purchase] = result[0].results;
    if (!purchase) return { status: "unclassified" };
    // Retained terminal fingerprints remain recognized after account-linked rows are erased.
    if (["deleted", "retired"].includes(purchase.state)) return { status: "inactive" };
    if (
      purchase.state !== "granted" ||
      purchase.payment_id !== paymentId ||
      !validTopupCheckoutId(purchase.checkout_id) ||
      purchase.checkout_hash !==
        (await referenceHash("checkout", livemode, purchase.checkout_id)) ||
      typeof resolveOffer !== "function" ||
      typeof fetchImpl !== "function"
    )
      return pending();
    if (invalidHistory) return pending();
    const resolvedOffer = await resolveOffer(purchase.offer_version, livemode);
    const offer = history ? structuredClone(resolvedOffer) : resolvedOffer;
    if (offer?.version !== purchase.offer_version || offer?.livemode !== livemode) return pending();
    if (history) {
      const observation = await observeVerifiedTopupEvent(db, config, observedEvent, {
        ...history,
        fetchImpl,
        resolveOffer: (version, mode) =>
          version === offer.version && mode === offer.livemode ? offer : null,
      });
      if (!["observed", "duplicate"].includes(observation.status)) return pending();
    }
    // Recovery captures a NEW revision and reads NEW payment/reversal evidence after observation.
    // Event status, totals and timestamp never decide a credit transition. The existing
    // bounded readers, committed prior state and revision CAS remain authoritative.
    const recovered = await recoverTopupPurchase(db, config, paymentHash, offer, fetchImpl);
    return recovered.status === "applied" ? { status: "reconciled" } : pending();
  } catch {
    return pending();
  }
}
