// Dormant handoff for Checkout events returned by the existing signature verifier.
import { recoverTopupAttempt } from "./topup-attempt-recovery.js";
import { validTopupCheckoutId } from "./topup-ledger.js";

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
  if (!validTopupCheckoutId(checkoutId) || checkoutId !== checkoutId.trim())
    return marked ? pending() : unclassified();

  const attemptId = marked ? checkout.metadata.attempt_id : null;
  if (marked && !validAttemptId(attemptId)) return pending();
  const livemode = event.livemode;
  const matchesEvent =
    checkout.object === "checkout.session" &&
    checkout.mode === "payment" &&
    typeof livemode === "boolean" &&
    checkout.livemode === livemode;
  const user = checkout.metadata?.user_hash;
  const version = checkout.metadata?.offer_version;
  const units = checkout.metadata?.units;
  const reference = checkout.client_reference_id;
  try {
    // Primary-key and unique Checkout lookups can identify distinct rows on a collision.
    const { success, results } = await db
      .prepare(
        "SELECT id,user_hash,offer_version,units,checkout_id,state FROM topup_checkout_attempts " +
          "WHERE id=? OR checkout_id=? LIMIT 2",
      )
      .bind(attemptId, checkoutId)
      .all();
    if (success !== true || !Array.isArray(results) || results.length > 1) return pending();
    const [attempt] = results;
    if (!attempt) return marked ? { status: "inactive" } : unclassified();
    if (
      !marked ||
      !matchesEvent ||
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
    if (typeof resolveOffer !== "function" || typeof fetchImpl !== "function") return pending();
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
