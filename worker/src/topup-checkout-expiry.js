// Dormant terminal transition. Evidence is a trusted authoritative-reader result,
// never a browser cancellation, webhook delta, elapsed timer or provider error.
import { referenceHash, validTopupCheckoutId, validTopupOfferVersion } from "./topup-ledger.js";

import { sessionWriteFence } from "./session.js";

// Capture with captureTopupSettlement BEFORE reading the provider. A stale result requires
// a new capture AND a new authoritative read. No grant, provider write or deletion here.
export async function expireTopupCheckout(db, capture, evidence, session) {
  let a, e;
  try {
    [a, e] = structuredClone([capture, evidence]);
  } catch {
    return { status: "retry" };
  }
  if (
    typeof a?.id !== "string" ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(a.id) ||
    !Number.isSafeInteger(a.revision) ||
    a.revision < 1 ||
    !["creating", "open"].includes(a.state) ||
    typeof a.user_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(a.user_hash) ||
    !validTopupOfferVersion(a.offer_version) ||
    a.amount !== 300 ||
    a.currency !== "usd" ||
    a.units !== 25 ||
    typeof a.created !== "string" ||
    !(a.checkout_id === null || validTopupCheckoutId(a.checkout_id)) ||
    e?.status !== "expired_evidence" ||
    e.attemptId !== a.id ||
    e.userHash !== a.user_hash ||
    e.offerVersion !== a.offer_version ||
    e.offerAmount !== a.amount ||
    e.currency !== a.currency ||
    e.units !== a.units ||
    typeof e.livemode !== "boolean" ||
    !validTopupCheckoutId(e.checkoutId) ||
    (a.checkout_id !== null && a.checkout_id !== e.checkoutId)
  )
    return { status: "retry" };
  const checkoutHash = await referenceHash("checkout", e.livemode, e.checkoutId);
  const fence = sessionWriteFence(session, "topup_checkout_attempts.user_hash");
  const [expired, consumed] = await db.batch([
    db
      .prepare(
        "UPDATE topup_checkout_attempts SET checkout_id=?,state='expired' " +
          "WHERE id=? AND state IN ('creating','open') AND state=? AND checkout_id IS ? " +
          "AND user_hash=? AND offer_version=? AND amount=? AND currency=? AND units=? AND created=? " +
          "AND EXISTS(SELECT 1 FROM topup_attempt_revisions WHERE attempt_id=? AND revision=?) " +
          "AND NOT EXISTS(SELECT 1 FROM topup_claims WHERE checkout_hash=?)" +
          fence.sql,
      )
      .bind(
        e.checkoutId,
        a.id,
        a.state,
        a.checkout_id,
        a.user_hash,
        a.offer_version,
        a.amount,
        a.currency,
        a.units,
        a.created,
        a.id,
        a.revision,
        checkoutHash,
        ...fence.args,
      ),
    // Consumed only after a successful terminal CAS, without an overflowing increment.
    db.prepare("DELETE FROM topup_attempt_revisions WHERE attempt_id=? AND changes()=1").bind(a.id),
  ]);
  if (expired.meta.changes === 0 && consumed.meta.changes === 0) return { status: "stale" };
  if (expired.meta.changes !== 1 || consumed.meta.changes !== 1)
    throw new Error("Invalid top-up expiry transaction");
  return { status: "expired" };
}
