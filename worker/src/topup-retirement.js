// Dormant trusted storage coordinator. The injected reader must obtain COMPLETE authoritative
// reversal evidence after capture, never accept browser data or cache a prior observation.
import { referenceHash } from "./topup-ledger.js";
import { reconcileExistingTopup } from "./topup-reconciliation.js";
import { invalidateTopupRetention } from "./topup-retention.js";
import { decideTopup } from "./topup-decisions.js";
import {
  topupFinanciallyResolved,
  topupHistoryProven,
  financialEvidenceDigest,
} from "./topup-retention.js";

export async function retireResolvedTopup(db, paymentHash, readFreshEvidence) {
  if (!/^[a-f0-9]{64}$/.test(paymentHash || "") || typeof readFreshEvidence !== "function")
    return { status: "pending" };
  // One read captures the committed history and anchor before the external evidence phase.
  const p = await db
    .prepare(
      "SELECT p.*,c.checkout_hash,r.revision,r.loss,r.full_refund,r.hold_ids," +
        "t.resolved_at,t.resolved_zero_since,t.history_proven,t.evidence_digest FROM topup_purchases p " +
        "JOIN topup_claims c ON c.payment_hash=p.payment_hash JOIN topup_reconciliations r ON r.payment_hash=p.payment_hash " +
        "JOIN topup_retention t ON t.payment_hash=p.payment_hash WHERE p.payment_hash=? AND c.state='granted'",
    )
    .bind(paymentHash)
    .first();
  if (!p) return { status: "unavailable" };
  if (
    !p.evidence_digest ||
    p.history_proven !== 1 ||
    p.loss ||
    p.available + p.held !== 0 ||
    !p.resolved_zero_since
  )
    return { status: "pending" };
  let evidence;
  try {
    evidence = structuredClone(await readFreshEvidence(structuredClone(p)));
  } catch {
    return { status: "pending" };
  } // Failed reads never manufacture resolution or erase.
  if (
    evidence?.status !== "reversal_evidence" ||
    typeof evidence.livemode !== "boolean" ||
    !/^ch_[A-Za-z0-9_]{1,250}$/.test(evidence.chargeId || "") ||
    evidence.paymentId !== p.payment_id ||
    evidence.checkoutId !== p.checkout_id ||
    evidence.capturedAmount !== p.amount ||
    evidence.currency !== p.currency
  )
    return { status: "pending" };
  const [payment, checkout] = await Promise.all([
    referenceHash("payment", evidence.livemode, evidence.paymentId),
    referenceHash("checkout", evidence.livemode, evidence.checkoutId),
  ]);
  const previous = {
    deleted: false,
    loss: !!p.loss,
    fullRefund: !!p.full_refund,
    held: false,
    heldDisputeIds: JSON.parse(p.hold_ids),
    historyProven: true,
  };
  previous.held = previous.heldDisputeIds.length > 0;
  const decision = decideTopup({ ...evidence, previous });
  if (payment !== paymentHash || checkout !== p.checkout_hash) return { status: "pending" };
  const digest = await financialEvidenceDigest(evidence);
  if (
    !digest ||
    digest !== p.evidence_digest ||
    !topupFinanciallyResolved(evidence, previous) ||
    !topupHistoryProven(evidence, previous, decision) ||
    decision.fullRefundSeen !== previous.fullRefund ||
    decision.lossSeen ||
    decision.heldDisputeIds.length
  ) {
    // Do not discard a positively observed unresolved state and later reuse its old age.
    // Existing revision CAS records causes/terminal flags and clears unresolved anchors.
    // A newly observed terminal outcome also starts a fresh conservative retention period.
    if (
      decision.disposition !== "retry" &&
      (decision.fullRefundSeen !== previous.fullRefund || decision.lossSeen !== previous.loss)
    )
      await invalidateTopupRetention(db, paymentHash, p.revision);
    await reconcileExistingTopup(db, paymentHash, p.revision, evidence);
    return { status: "pending" };
  }
  const [claim, removed] = await db.batch([
    db
      .prepare(
        "UPDATE topup_claims SET state='retired' WHERE payment_hash=? AND checkout_hash=? AND state='granted' AND EXISTS(" +
          "SELECT 1 FROM topup_purchases p JOIN topup_reconciliations r ON r.payment_hash=p.payment_hash " +
          "JOIN topup_retention t ON t.payment_hash=p.payment_hash WHERE p.payment_hash=topup_claims.payment_hash " +
          "AND p.payment_id=? AND p.checkout_id=? AND p.user_hash=? AND p.available=0 AND p.held=0 " +
          "AND r.revision=? AND r.loss=0 AND r.full_refund=? AND r.hold_ids=? AND t.history_proven=1 " +
          "AND t.resolved_at=? AND t.resolved_zero_since=? AND t.evidence_digest=? " +
          "AND t.resolved_zero_since<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-400 days') " +
          "AND NOT EXISTS(SELECT 1 FROM topup_allocations a JOIN runs u ON u.user_hash=a.user_hash " +
          "AND u.month=a.month AND u.task=a.task AND u.run_id=a.run_id WHERE a.payment_hash=p.payment_hash) " +
          "AND NOT EXISTS(SELECT 1 FROM topup_generation_allocations a JOIN funded_runs f ON f.generation=a.generation " +
          "WHERE a.payment_hash=p.payment_hash) " +
          "AND NOT EXISTS(SELECT 1 FROM topup_checkout_attempts a WHERE a.checkout_id=p.checkout_id AND a.state!='settled'))",
      )
      .bind(
        paymentHash,
        p.checkout_hash,
        p.payment_id,
        p.checkout_id,
        p.user_hash,
        p.revision,
        p.full_refund,
        p.hold_ids,
        p.resolved_at,
        p.resolved_zero_since,
        digest,
      ),
    // The first guarded write is decisive. Cascades erase allocations, reconciliation and
    // retention, but leave terminal fingerprints. No run/account/session data is deleted.
    db
      .prepare("DELETE FROM topup_purchases WHERE payment_hash=? AND changes()=1")
      .bind(paymentHash),
    db
      .prepare(
        "DELETE FROM topup_checkout_attempts WHERE checkout_id=? AND user_hash=? " +
          "AND offer_version=? AND units=? AND currency=? AND state='settled' AND changes()=1",
      )
      .bind(p.checkout_id, p.user_hash, p.offer_version, p.granted, p.currency),
  ]);
  return { status: claim.meta.changes === 1 && removed.meta.changes >= 1 ? "retired" : "stale" };
}
