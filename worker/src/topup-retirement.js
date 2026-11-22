// Dormant trusted storage coordinator. The injected reader must obtain COMPLETE authoritative
// reversal evidence after capture, never accept browser data or cache a prior observation.
import { TOPUP_SETTLEMENT_TERMS } from "./topup-first-settlement.js";
import { referenceHash } from "./topup-ledger.js";
import { reconcileExistingTopup } from "./topup-reconciliation.js";
import { invalidateTopupRetention } from "./topup-retention.js";
import { decideTopup } from "./topup-decisions.js";
import {
  topupFinanciallyResolved,
  topupHistoryProven,
  financialEvidenceDigest,
} from "./topup-retention.js";

const UTC = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const UTC_MS = "(unixepoch('now')*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
// Hard ceiling from Stripe's Events lookback, not an approved live lag allowance.
const MAX_COVERAGE_LAG_MS = 30 * 86400000;
const canonicalTime = (value) =>
  typeof value === "string" &&
  value.length === 24 &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const data = (value, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error();
  return descriptor.value;
};

// The trusted verifier must justify the configured lag and attest this exact interval
// against the captured database time. Restore operations must invalidate the epoch before
// deletion can run. The first settlement boundary comes from authoritative provider history.
async function verifyRetirementHistory(verifyHistory, snapshot) {
  try {
    const proof = await verifyHistory(snapshot);
    if (
      !proof ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(proof)) ||
      Reflect.ownKeys(proof).sort().join(",") !== "currentThrough,firstSettledAt,snapshot,status" ||
      data(proof, "status") !== "verified" ||
      data(proof, "snapshot") !== snapshot
    )
      return null;
    const firstSettledAt = data(proof, "firstSettledAt"),
      currentThrough = data(proof, "currentThrough");
    if (
      !canonicalTime(firstSettledAt) ||
      !canonicalTime(currentThrough) ||
      currentThrough !== snapshot.coverage.coveredThrough ||
      currentThrough > snapshot.observedAt ||
      Date.parse(snapshot.observedAt) - Date.parse(currentThrough) > snapshot.maxCoverageLagMs ||
      firstSettledAt < snapshot.attemptCreated ||
      firstSettledAt < snapshot.coverage.startsAt ||
      firstSettledAt > currentThrough ||
      firstSettledAt > snapshot.resolvedAt ||
      firstSettledAt > snapshot.resolvedZeroSince
    )
      return null;
    return { firstSettledAt, currentThrough };
  } catch {
    return null;
  }
}

export async function retireResolvedTopup(db, paymentHash, readFreshEvidence, authority) {
  let livemode, maxCoverageLagMs, verifyHistory;
  try {
    livemode = data(authority, "livemode");
    maxCoverageLagMs = data(authority, "maxCoverageLagMs");
    verifyHistory = data(authority, "verifyHistory");
    if (
      typeof paymentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(paymentHash) ||
      typeof readFreshEvidence !== "function" ||
      typeof livemode !== "boolean" ||
      !Number.isSafeInteger(maxCoverageLagMs) ||
      maxCoverageLagMs < 1 ||
      maxCoverageLagMs > MAX_COVERAGE_LAG_MS ||
      typeof verifyHistory !== "function"
    )
      return { status: "pending" };
  } catch {
    return { status: "pending" };
  }
  const mode = livemode ? "live" : "test";
  // One read captures the committed history and anchor before the external evidence phase.
  const p = await db
    .prepare(
      "SELECT p.*,a.id AS attempt_id,a.amount AS attempt_amount,a.created AS attempt_created,a.state AS attempt_state," +
        "c.checkout_hash,r.revision,r.loss,r.full_refund,r.hold_ids," +
        "t.resolved_at,t.resolved_zero_since,t.history_proven,t.evidence_digest,t.coverage_epoch," +
        "h.schema_key AS coverage_schema,h.starts_at AS coverage_start," +
        "h.covered_through,h.revision AS coverage_revision," +
        UTC +
        " AS observed_at FROM topup_purchases p " +
        "JOIN topup_claims c ON c.payment_hash=p.payment_hash JOIN topup_reconciliations r ON r.payment_hash=p.payment_hash " +
        "JOIN topup_retention t ON t.payment_hash=p.payment_hash " +
        "JOIN topup_checkout_attempts a ON a.checkout_id=p.checkout_id AND a.user_hash=p.user_hash " +
        "AND a.offer_version=p.offer_version AND a.units=p.granted AND a.currency=p.currency " +
        "AND a.amount=? AND a.currency=? AND a.units=? AND p.amount>=a.amount AND a.state='settled' " +
        "LEFT JOIN topup_history_coverage h ON h.mode=? AND h.epoch=t.coverage_epoch " +
        "AND h.health='qualified' AND h.covered_through<=" +
        UTC +
        " " +
        "WHERE p.payment_hash=? AND c.state='granted'",
    )
    .bind(
      TOPUP_SETTLEMENT_TERMS.amount,
      TOPUP_SETTLEMENT_TERMS.currency,
      TOPUP_SETTLEMENT_TERMS.units,
      mode,
      paymentHash,
    )
    .first();
  if (!p) return { status: "unavailable" };
  if (
    !p.evidence_digest ||
    p.history_proven !== 1 ||
    p.loss ||
    p.available + p.held !== 0 ||
    !canonicalTime(p.resolved_at) ||
    !canonicalTime(p.resolved_zero_since) ||
    p.resolved_at > p.resolved_zero_since ||
    !p.coverage_epoch ||
    !Number.isSafeInteger(p.coverage_revision) ||
    !canonicalTime(p.observed_at)
  )
    return { status: "pending" };
  const [payment, checkout] = await Promise.all([
    referenceHash("payment", livemode, p.payment_id),
    referenceHash("checkout", livemode, p.checkout_id),
  ]);
  if (payment !== paymentHash || checkout !== p.checkout_hash) return { status: "pending" };

  let observed;
  try {
    observed = await readFreshEvidence(structuredClone(p));
  } catch {
    return { status: "pending" };
  } // Transport failure is not financial evidence.
  const hashing = financialEvidenceDigest(observed);
  let evidence;
  try {
    evidence = structuredClone(observed);
  } catch {
    // Unsupported JSON still invalidates an exactly associated observation. Read only
    // own data properties here, never execute an accessor or retain the rejected payload.
    evidence = {};
    for (const key of [
      "status",
      "livemode",
      "chargeId",
      "paymentId",
      "checkoutId",
      "capturedAmount",
      "currency",
    ]) {
      const descriptor = observed && Object.getOwnPropertyDescriptor(observed, key);
      if (descriptor && "value" in descriptor) evidence[key] = descriptor.value;
    }
  }
  const digest = await hashing;
  if (
    evidence?.status !== "reversal_evidence" ||
    evidence.livemode !== livemode ||
    typeof evidence.paymentId !== "string" ||
    typeof evidence.checkoutId !== "string" ||
    typeof evidence.currency !== "string" ||
    !Number.isSafeInteger(evidence.capturedAmount) ||
    evidence.paymentId !== p.payment_id ||
    evidence.checkoutId !== p.checkout_id ||
    evidence.capturedAmount !== p.amount ||
    evidence.currency !== p.currency
  )
    return { status: "pending" };
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
  if (
    typeof evidence.chargeId !== "string" ||
    !/^ch_[A-Za-z0-9_]{1,250}$/.test(evidence.chargeId) ||
    !digest
  ) {
    await invalidateTopupRetention(db, paymentHash, p.revision);
    return { status: "pending" };
  }
  if (
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
  // Require fresh provider and restore authority only at the destructive boundary.
  // Existing observation paths above may still invalidate or reconcile changed evidence.
  const snapshot = Object.freeze({
    paymentHash,
    paymentId: p.payment_id,
    checkoutId: p.checkout_id,
    chargeId: evidence.chargeId,
    attemptId: p.attempt_id,
    attemptCreated: p.attempt_created,
    resolvedAt: p.resolved_at,
    resolvedZeroSince: p.resolved_zero_since,
    revision: p.revision,
    observedAt: p.observed_at,
    maxCoverageLagMs,
    coverage: Object.freeze({
      mode,
      epoch: p.coverage_epoch,
      schemaKey: p.coverage_schema,
      startsAt: p.coverage_start,
      coveredThrough: p.covered_through,
      revision: p.coverage_revision,
    }),
  });
  const history = await verifyRetirementHistory(verifyHistory, snapshot);
  if (!history) return { status: "pending" };
  const { firstSettledAt, currentThrough } = history;

  const purchaseTuple =
    "payment_id=? AND checkout_id=? AND user_hash=? AND offer_version=? AND amount=? AND currency=? AND granted=? AND created=?";
  const purchaseValues = [
    p.payment_id,
    p.checkout_id,
    p.user_hash,
    p.offer_version,
    p.amount,
    p.currency,
    p.granted,
    p.created,
  ];
  const attemptTuple =
    "id=? AND user_hash=? AND checkout_id=? AND offer_version=? AND amount=? AND units=? AND currency=? AND state=? AND created=?";
  const attemptValues = [
    p.attempt_id,
    p.user_hash,
    p.checkout_id,
    p.offer_version,
    p.attempt_amount,
    p.granted,
    p.currency,
    p.attempt_state,
    p.attempt_created,
  ];
  const qualified = (tuple, alias) =>
    tuple
      .split(" AND ")
      .map((part) => alias + "." + part)
      .join(" AND ");
  const [claim, removed, attempt] = await db.batch([
    db
      .prepare(
        "UPDATE topup_claims SET state='retired' WHERE payment_hash=? AND checkout_hash=? AND state='granted' AND EXISTS(" +
          "SELECT 1 FROM topup_purchases p JOIN topup_reconciliations r ON r.payment_hash=p.payment_hash " +
          "JOIN topup_retention t ON t.payment_hash=p.payment_hash " +
          "JOIN topup_checkout_attempts a ON a.checkout_id=p.checkout_id " +
          "WHERE p.payment_hash=topup_claims.payment_hash AND " +
          qualified(purchaseTuple, "p") +
          " AND " +
          qualified(attemptTuple, "a") +
          " AND p.available=0 AND p.held=0 " +
          "AND r.revision=? AND r.loss=0 AND r.full_refund=? AND r.hold_ids=? AND t.history_proven=1 " +
          "AND t.resolved_at=? AND t.resolved_zero_since=? AND t.evidence_digest=? " +
          "AND t.resolved_zero_since<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-400 days') " +
          "AND t.coverage_epoch=? AND EXISTS(SELECT 1 FROM topup_history_coverage h " +
          "WHERE h.mode=? AND h.epoch=t.coverage_epoch AND h.schema_key=? AND h.starts_at=? " +
          "AND h.covered_through=? AND h.revision=? AND h.health='qualified' " +
          "AND h.starts_at<=? AND a.created<=? AND ?<=t.resolved_at AND ?<=t.resolved_zero_since " +
          "AND h.covered_through>=strftime('%Y-%m-%dT%H:%M:%fZ',t.resolved_zero_since,'+400 days') " +
          "AND h.covered_through<=? AND ?<=" +
          UTC +
          " " +
          "AND " +
          UTC_MS +
          "-?<=?) " +
          "AND NOT EXISTS(SELECT 1 FROM topup_allocations a JOIN runs u ON u.user_hash=a.user_hash " +
          "AND u.month=a.month AND u.task=a.task AND u.run_id=a.run_id WHERE a.payment_hash=p.payment_hash) " +
          "AND NOT EXISTS(SELECT 1 FROM topup_generation_allocations a JOIN funded_runs f ON f.generation=a.generation " +
          "WHERE a.payment_hash=p.payment_hash))",
      )
      .bind(
        paymentHash,
        p.checkout_hash,
        ...purchaseValues,
        ...attemptValues,
        p.revision,
        p.full_refund,
        p.hold_ids,
        p.resolved_at,
        p.resolved_zero_since,
        digest,
        p.coverage_epoch,
        mode,
        p.coverage_schema,
        p.coverage_start,
        currentThrough,
        p.coverage_revision,
        firstSettledAt,
        firstSettledAt,
        firstSettledAt,
        firstSettledAt,
        p.observed_at,
        p.observed_at,
        Date.parse(currentThrough),
        maxCoverageLagMs,
      ),
    // The decisive guard and both deletes use the captured immutable tuples. Cascades
    // remove children, while terminal fingerprints and unrelated account data survive.
    db
      .prepare(
        "DELETE FROM topup_purchases WHERE payment_hash=? AND " +
          purchaseTuple +
          " AND changes()=1",
      )
      .bind(paymentHash, ...purchaseValues),
    db
      .prepare("DELETE FROM topup_checkout_attempts WHERE " + attemptTuple + " AND changes()=1")
      .bind(...attemptValues),
  ]);
  if (claim.meta.changes === 0) return { status: "stale" };
  if (claim.meta.changes !== 1 || removed.meta.changes < 1 || attempt.meta.changes < 1)
    throw new Error("Invalid top-up retirement transaction");
  return { status: "retired" };
}
