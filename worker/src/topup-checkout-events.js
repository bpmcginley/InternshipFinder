// Dormant handoff for Checkout events returned by the existing signature verifier.
import { recoverTopupAttempt } from "./topup-attempt-recovery.js";
import { referenceHash, validTopupCheckoutId } from "./topup-ledger.js";

const recoveryEvents = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
]);
const pending = () => ({ status: "pending" });
const unclassified = () => ({ status: "unclassified" });
const validAttemptId = (value) =>
  typeof value === "string" &&
  value.length === 36 &&
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);

// resolveOffer reads trusted historical configuration for the stored offer version and mode.
// An unclassified Checkout result is only absence of a known top-up association.
export async function recoverVerifiedTopupCheckoutEvent({
  db,
  env,
  event,
  resolveOffer,
  fetchImpl,
  clock,
} = {}) {
  const type = event?.type;
  if (typeof type !== "string" || !type.startsWith("checkout.session.")) return unclassified();
  const checkout = event.data?.object;
  const marked = checkout?.metadata?.kind === "autofill_topup";
  const checkoutId = checkout?.id;
  if (!validTopupCheckoutId(checkoutId) || checkoutId !== checkoutId.trim()) return pending();

  const hint = checkout.metadata?.attempt_id;
  const attemptId = validAttemptId(hint) ? hint : null;
  if (marked && !attemptId) return pending();
  const livemode = event.livemode;
  if (
    checkout.object !== "checkout.session" ||
    typeof livemode !== "boolean" ||
    checkout.livemode !== livemode
  )
    return pending();
  const mode = checkout.mode;
  const user = checkout.metadata?.user_hash;
  const version = checkout.metadata?.offer_version;
  const units = checkout.metadata?.units;
  const reference = checkout.client_reference_id;
  try {
    // Read the durable attempt and retained Checkout fingerprint in the same D1 batch.
    const checkoutHash = await referenceHash("checkout", livemode, checkoutId);
    const lookups = await db.batch([
      db
        .prepare(
          "SELECT id,user_hash,offer_version,units,checkout_id,state FROM topup_checkout_attempts " +
            "WHERE id=? OR checkout_id=? LIMIT 2",
        )
        .bind(attemptId, checkoutId),
      db.prepare("SELECT 1 AS known FROM topup_claims WHERE checkout_hash=?").bind(checkoutHash),
    ]);
    if (
      lookups.length !== 2 ||
      lookups.some((result) => result?.success !== true || !Array.isArray(result.results)) ||
      lookups[0].results.length > 1 ||
      lookups[1].results.length > 1
    )
      return pending();
    const [attempt] = lookups[0].results;
    const knownClaim = lookups[1].results.length === 1;
    if (!attempt) return marked || knownClaim ? { status: "inactive" } : unclassified();
    if (
      !marked ||
      mode !== "payment" ||
      attempt.id !== attemptId ||
      (attempt.checkout_id !== null && attempt.checkout_id !== checkoutId) ||
      attempt.user_hash !== user ||
      attempt.user_hash !== reference ||
      attempt.offer_version !== version ||
      String(attempt.units) !== units
    )
      return pending();
    if (!recoveryEvents.has(type)) return { status: "ignored" };
    if (attempt.state === "settled" || attempt.state === "expired")
      return attempt.checkout_id === checkoutId ? { status: "inactive" } : pending();
    if (knownClaim || typeof resolveOffer !== "function" || typeof fetchImpl !== "function")
      return pending();
    const offer = await resolveOffer(attempt.offer_version, livemode);
    if (offer?.version !== attempt.offer_version || offer?.livemode !== livemode) return pending();
    const result = await recoverTopupAttempt(db, env, attempt.id, offer, fetchImpl, {
      candidateCheckoutId: checkoutId,
      clock,
    });
    // The signed event is a recovery hint. The existing authoritative GET and revision
    // fences decide settlement or expiry. Nothing from the provider is returned here.
    return ["settled", "expired", "inactive"].includes(result.status)
      ? { status: result.status }
      : pending();
  } catch {
    return pending();
  }
}
