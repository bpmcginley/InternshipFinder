// Dormant handoff for snapshot events returned by the existing signature verifier.
import { referenceHash, validTopupCheckoutId } from "./topup-ledger.js";
import { recoverTopupPurchase } from "./topup-purchase-recovery.js";

const eventObjects = new Map([
  ...["refund.created", "refund.updated", "refund.failed", "charge.refund.updated"].map((t) => [
    t,
    "refund",
  ]),
  ["charge.refunded", "charge"],
  ...["created", "updated", "closed", "funds_withdrawn", "funds_reinstated"].map((t) => [
    "charge.dispute." + t,
    "dispute",
  ]),
]);
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
} = {}) {
  const expected = eventObjects.get(event?.type);
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
    const offer = await resolveOffer(purchase.offer_version, livemode);
    if (offer?.version !== purchase.offer_version || offer?.livemode !== livemode) return pending();
    // Event status, totals and timestamp never decide a credit transition. The existing
    // bounded readers, committed prior state and revision CAS remain authoritative.
    const recovered = await recoverTopupPurchase(db, env, paymentHash, offer, fetchImpl);
    return recovered.status === "applied" ? { status: "reconciled" } : pending();
  } catch {
    return pending();
  }
}
