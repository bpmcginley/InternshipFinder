// Dormant, pure #226 policy. No provider verification, grant, SQL or production caller.
// The trusted adapter must associate every object with this purchase and supply complete
// current lists (including every dispute governing an existing hold), not webhook deltas.
const REFUNDS = new Set(["succeeded", "pending", "requires_action", "failed", "canceled"]);
const ACTIVE = new Set([
  "needs_response",
  "under_review",
  "appeal_needs_response",
  "appeal_under_review",
]);
const FAVORABLE = new Set(["won", "warning_closed", "prevented"]);
const DISPUTES = new Set([
  ...ACTIVE,
  ...FAVORABLE,
  "warning_needs_response",
  "warning_under_review",
  "lost",
]);
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const identifier = (id) => typeof id === "string" && id.length > 0 && id.length <= 255;
const retry = (reason) => ({ disposition: "retry", reason });

// Repeated identical current objects are harmless. Conflicting versions of one ID are not
// ordered here: the caller must reread/reconcile them. Amounts include charged tax, not fees.
function distinct(list, statuses, currency, captured) {
  if (!Array.isArray(list)) return null;
  const byId = new Map();
  for (const item of list) {
    if (
      !item ||
      !identifier(item.id) ||
      !statuses.has(item.status) ||
      item.currency !== currency ||
      !positive(item.amount) ||
      item.amount > captured
    )
      return null;
    const old = byId.get(item.id);
    if (
      old &&
      (old.status !== item.status || old.amount !== item.amount || old.currency !== item.currency)
    )
      return null;
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

// previous contains committed terminal/held booleans and governing heldDisputeIds.
// A retry result has no proposed state: retain the last verified allocation, and authorize
// neither a release nor a new grant. Commit decisions only under serialized revision/CAS.
export function decideTopup(snapshot) {
  const previous = snapshot?.previous;
  if (
    !previous ||
    !["deleted", "fullRefund", "loss", "held"].every((key) => typeof previous[key] === "boolean") ||
    !Array.isArray(previous.heldDisputeIds) ||
    !previous.heldDisputeIds.every(identifier) ||
    previous.held !== previous.heldDisputeIds.length > 0
  ) {
    return retry("invalid_previous");
  }
  const result = (
    disposition,
    reason,
    lossSeen = previous.loss,
    fullRefundSeen = previous.fullRefund,
    manualReview = false,
  ) => ({ disposition, reason, lossSeen, fullRefundSeen, manualReview, heldDisputeIds: [] });
  // Trusted durable terminal facts take precedence even when a provider read is unavailable.
  if (previous.deleted) return result("revoked", "deleted");
  if (previous.fullRefund) return result("revoked", "full_refund");
  // manualReview gates restoration; it never requests an automatic case on each replay.
  const unresolved = (reason) =>
    previous.loss ? result("revoked", "prior_loss", true, false, true) : retry(reason);
  if (snapshot.refundsComplete !== true || snapshot.disputesComplete !== true)
    return unresolved("incomplete_snapshot");
  if (
    !positive(snapshot.capturedAmount) ||
    typeof snapshot.currency !== "string" ||
    !/^[a-z]{3}$/.test(snapshot.currency)
  ) {
    return unresolved("invalid_payment");
  }
  const refunds = distinct(snapshot.refunds, REFUNDS, snapshot.currency, snapshot.capturedAmount);
  const disputes = distinct(
    snapshot.disputes,
    DISPUTES,
    snapshot.currency,
    snapshot.capturedAmount,
  );
  if (!refunds || !disputes) return unresolved("inconsistent_snapshot");
  let refunded = 0;
  for (const refund of refunds) {
    if (refund.status !== "succeeded") continue;
    if (refunded > snapshot.capturedAmount - refund.amount)
      return unresolved("inconsistent_refund_total");
    refunded += refund.amount;
  }
  const lost = disputes.some((item) => item.status === "lost");
  if (refunded === snapshot.capturedAmount)
    return result("revoked", "full_refund", previous.loss || lost, true);
  if (previous.loss) return result("revoked", "prior_loss", true, false, true);
  if (lost) return result("revoked", "lost", true);
  const current = new Map(disputes.map((item) => [item.id, item.status]));
  if (
    !previous.heldDisputeIds.every(
      (id) => ACTIVE.has(current.get(id)) || FAVORABLE.has(current.get(id)),
    )
  )
    return retry("unresolved_hold");
  const heldDisputeIds = disputes
    .filter((item) => ACTIVE.has(item.status))
    .map((item) => item.id)
    .sort();
  if (heldDisputeIds.length) return { ...result("held", "active_dispute"), heldDisputeIds };
  return result("available", previous.held ? "favorable_dispute" : "clear");
}
